/**
 * community_discovery.js - Infomap Community Detection & ORA Functional Enrichment Engine
 *
 * Runs official WebAssembly Infomap (`@mapequation/infomap/node`) on the user's
 * currently visible subgraph and evaluates Over-Representation Analysis (ORA)
 * using exact upper-tail Hypergeometric tests (`@stdlib/stats-base-dists-hypergeometric-pmf`)
 * with Benjamini-Hochberg FDR adjustment (`@stdlib/stats-padjust`) across
 * GO:BP, GO:MF, GO:CC (with true-path DAG propagation), KEGG, and MapMan annotations.
 */

const neo4j = require("neo4j-driver");
const { run: runInfomapWasm } = require("@mapequation/infomap/node");
const hypergeomPmf = require("@stdlib/stats-base-dists-hypergeometric-pmf");
const padjust = require("@stdlib/stats-padjust");

const SOURCES = ["GO:BP", "GO:MF", "GO:CC", "KEGG", "MapMan"];
const GO_ROOT_TERMS = new Set([
  "GO:0008150", // biological_process
  "GO:0003674", // molecular_function
  "GO:0005575", // cellular_component
]);

const DOMAIN_TO_SOURCE = {
  biological_process: "GO:BP",
  molecular_function: "GO:MF",
  cellular_component: "GO:CC",
  "GO:BP": "GO:BP",
  "GO:MF": "GO:MF",
  "GO:CC": "GO:CC",
};

// Memoized Neo4j annotation index promise
let cachedIndexPromise = null;

function normalizeKey(val) {
  return String(val || "").trim().toLowerCase();
}

function normalizeMsuKey(val) {
  return normalizeKey(val).replace(/^loc_/, "").replace(/\.\d+$/, "");
}

function normalizeRapKey(val) {
  return normalizeKey(val).replace(/^(os\d{2})t(\d{7})(-\d+)?$/, "$1g$2");
}

function cleanKeggName(name) {
  if (!name) return "";
  return String(name)
    .replace(/\s*-\s*Oryza sativa japonica.*$/i, "")
    .trim();
}

function shortClusterLabel(term) {
  if (!term || !term.name) return term?.id || "Enriched cluster";
  let label = String(term.name).trim();
  if (term.source === "MapMan" && label.includes(".")) {
    const parts = label.split(".").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // Keep the most informative specific segment (last 2 parts if concise, else last)
      const tail2 = `${parts[parts.length - 2]}: ${parts[parts.length - 1]}`;
      label = tail2.length <= 48 ? tail2 : parts[parts.length - 1];
    }
  }
  if (label.length > 52) {
    label = label.slice(0, 49).trimEnd() + "...";
  }
  return label;
}

/**
 * Exact upper-tail hypergeometric p-value: P(X >= k)
 * where N = background size, M = term size in background, n = query size in background, k = overlap.
 * Summing PMF avoids floating-point cancellation from (1 - CDF) for tiny p-values (< 1e-16).
 */
function hypergeomUpperTail(k, N, M, n) {
  if (k <= 0) return 1;
  if (N <= 0 || M <= 0 || n <= 0) return 1;
  const maxK = Math.min(M, n);
  if (k > maxK) return 0;

  let p = 0;
  for (let i = k; i <= maxK; i++) {
    const v = hypergeomPmf(i, N, M, n);
    if (Number.isFinite(v)) p += v;
  }
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Resolves a raw gene identifier string (RAP, RAP transcript, MSU, symbol, identifier)
 * into a canonical DB RAP-DB gene ID using the cached ID lookup maps.
 */
function resolveGeneId(rawId, index) {
  if (!rawId) return null;
  const s = String(rawId).trim();
  if (!s || s === "." || s === "-") return null;

  const low = normalizeKey(s);
  if (index.idMap.has(low)) return index.idMap.get(low);

  const rap = normalizeRapKey(s);
  if (rap !== low && index.idMap.has(rap)) return index.idMap.get(rap);

  const msu = normalizeMsuKey(s);
  if (msu && index.msuMap.has(msu)) return index.msuMap.get(msu);

  if (low.startsWith("os") && low.length > 3 && !/^os\d{2}[gt]\d+/i.test(low)) {
    const stripped = low.slice(2);
    if (index.idMap.has(stripped)) return index.idMap.get(stripped);
  }

  return null;
}

/**
 * Loads and caches all gene IDs and functional annotations (GO + DAG, MapMan, KEGG) from Neo4j.
 */
async function buildAnnotationIndex(driver) {
  const t0 = Date.now();
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });

  const allGenes = new Set();
  const idMap = new Map();
  const msuMap = new Map();

  const namespaces = {};
  for (const src of SOURCES) {
    namespaces[src] = {
      termToGenes: new Map(),
      geneToTerms: new Map(),
      termMeta: new Map(),
      annotatedGenes: new Set(),
    };
  }

  const addTermLink = (source, geneId, termId, termName) => {
    const ns = namespaces[source];
    if (!ns || !geneId || !termId) return;

    let gSet = ns.termToGenes.get(termId);
    if (!gSet) {
      gSet = new Set();
      ns.termToGenes.set(termId, gSet);
    }
    if (!gSet.has(geneId)) {
      gSet.add(geneId);
      let tList = ns.geneToTerms.get(geneId);
      if (!tList) {
        tList = [];
        ns.geneToTerms.set(geneId, tList);
      }
      tList.push(termId);
      ns.annotatedGenes.add(geneId);
    }

    if (!ns.termMeta.has(termId)) {
      ns.termMeta.set(termId, {
        id: termId,
        name: termName || termId,
        source,
      });
    } else if (termName && ns.termMeta.get(termId).name === termId) {
      ns.termMeta.get(termId).name = termName;
    }
  };

  try {
    // 1. Load all genes & build multi-format ID resolution lookup
    const geneRes = await session.run(`
      MATCH (g:Gene)
      RETURN g.id AS id, g.msu_id AS msu_id, g.symbol AS symbol, g.identifier AS identifier
    `);

    const registerAlias = (map, key, canonicalId) => {
      if (!key || key === "." || key === "-" || key === "null" || key === "none") return;
      if (!map.has(key)) map.set(key, canonicalId);
    };

    for (const r of geneRes.records) {
      const id = r.get("id");
      if (!id) continue;
      const canonical = String(id).trim();
      allGenes.add(canonical);
      idMap.set(normalizeKey(canonical), canonical);

      const msu = r.get("msu_id");
      if (msu && msu !== ".") {
        String(msu)
          .split(/[,;\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .forEach((part) => {
            registerAlias(idMap, normalizeKey(part), canonical);
            registerAlias(msuMap, normalizeMsuKey(part), canonical);
          });
      }

      const identifier = r.get("identifier");
      if (identifier && identifier !== ".") {
        const k = normalizeKey(identifier);
        registerAlias(idMap, k, canonical);
        if (k.startsWith("os") && k.length > 3 && !/^os\d{2}[gt]\d+/i.test(k)) {
          registerAlias(idMap, k.slice(2), canonical);
        }
      }

      const symbol = r.get("symbol");
      if (symbol && symbol !== ".") {
        const k = normalizeKey(symbol);
        registerAlias(idMap, k, canonical);
        if (k.startsWith("os") && k.length > 3 && !/^os\d{2}[gt]\d+/i.test(k)) {
          registerAlias(idMap, k.slice(2), canonical);
        }
      }
    }

    // 2. Load GO terms and GO DAG edges (IS_A / PART_OF) directly from Neo4j for true-path propagation
    const goNodesRes = await session.run(`
      MATCH (t:GOTerm)
      RETURN t.id AS id, t.name AS name, t.domain AS domain
    `);
    const goDagRes = await session.run(`
      MATCH (c:GOTerm)-[:IS_A|PART_OF]->(p:GOTerm)
      RETURN c.id AS child, p.id AS parent
    `);
    const goLinksRes = await session.run(`
      MATCH (g:Gene)-[:HAS_GO_TERM]->(t:GOTerm)
      RETURN g.id AS geneId, t.id AS termId
    `);

    const goMeta = new Map();
    for (const r of goNodesRes.records) {
      const id = r.get("id");
      if (!id) continue;
      goMeta.set(id, {
        id,
        name: r.get("name") || id,
        source: DOMAIN_TO_SOURCE[r.get("domain")] || null,
      });
    }

    const goParents = new Map();
    for (const r of goDagRes.records) {
      const child = r.get("child");
      const parent = r.get("parent");
      if (!child || !parent || GO_ROOT_TERMS.has(parent)) continue;
      let list = goParents.get(child);
      if (!list) {
        list = [];
        goParents.set(child, list);
      }
      list.push(parent);
    }

    const goAncestorsMemo = new Map();
    const getGoAncestors = (termId) => {
      if (goAncestorsMemo.has(termId)) return goAncestorsMemo.get(termId);
      const visited = new Set();
      const stack = [termId];
      while (stack.length > 0) {
        const curr = stack.pop();
        const parents = goParents.get(curr);
        if (!parents) continue;
        for (let i = 0; i < parents.length; i++) {
          const p = parents[i];
          if (GO_ROOT_TERMS.has(p) || visited.has(p)) continue;
          visited.add(p);
          stack.push(p);
        }
      }
      const arr = Array.from(visited);
      goAncestorsMemo.set(termId, arr);
      return arr;
    };

    for (const r of goLinksRes.records) {
      const geneId = r.get("geneId");
      const termId = r.get("termId");
      if (!geneId || !termId || GO_ROOT_TERMS.has(termId)) continue;

      const meta = goMeta.get(termId);
      const source = meta && meta.source;
      if (source) {
        addTermLink(source, geneId, termId, meta.name);
      }

      const ancestors = getGoAncestors(termId);
      for (let i = 0; i < ancestors.length; i++) {
        const ancId = ancestors[i];
        const ancMeta = goMeta.get(ancId);
        const ancSource = (ancMeta && ancMeta.source) || source;
        if (!ancSource) continue;
        addTermLink(ancSource, geneId, ancId, (ancMeta && ancMeta.name) || ancId);
      }
    }

    var goDagEdgeCount = goDagRes.records.length;

    // 3. Load MapMan bins (already hierarchical via SUBCATEGORY_OF; exclude bin 35 "not assigned")
    const mmRes = await session.run(`
      MATCH (g:Gene)-[:HAS_MAPMAN]->(m:MapMan)
      OPTIONAL MATCH (m)-[:SUBCATEGORY_OF*0..]->(anc:MapMan)
      WITH g.id AS geneId, coalesce(anc, m) AS node
      RETURN DISTINCT geneId, node.bincode AS termId, node.name AS termName
    `);

    for (const r of mmRes.records) {
      const geneId = r.get("geneId");
      const termId = r.get("termId");
      if (!geneId || !termId) continue;
      const code = String(termId).trim();
      if (!code || code === "35" || code.startsWith("35.")) continue;
      addTermLink("MapMan", geneId, code, r.get("termName") || code);
    }

    // 4. Load KEGG pathways
    const keggRes = await session.run(`
      MATCH (g:Gene)-[:IN_PATHWAY]->(p:Pathway)
      RETURN g.id AS geneId, p.id AS termId, coalesce(p.name, p.title) AS termName
    `);

    for (const r of keggRes.records) {
      const geneId = r.get("geneId");
      const termId = r.get("termId");
      if (!geneId || !termId) continue;
      addTermLink("KEGG", geneId, termId, cleanKeggName(r.get("termName")) || termId);
    }
  } finally {
    await session.close();
  }

  const anyAnnotatedGenes = new Set();
  const summary = {};
  for (const src of SOURCES) {
    const ns = namespaces[src];
    ns.annotatedGenes.forEach((g) => anyAnnotatedGenes.add(g));
    summary[src] = {
      terms: ns.termToGenes.size,
      annotatedGenes: ns.annotatedGenes.size,
    };
  }

  console.log(
    `[CommunityDiscovery] Annotation index ready in ${Date.now() - t0} ms: ${allGenes.size} genes, ${anyAnnotatedGenes.size} annotated across`,
    summary
  );

  return {
    allGenes,
    anyAnnotatedGenes,
    idMap,
    msuMap,
    namespaces,
    goDagEdgeCount,
    summary,
  };
}

function getAnnotationIndex(driver) {
  if (!cachedIndexPromise) {
    cachedIndexPromise = buildAnnotationIndex(driver).catch((err) => {
      cachedIndexPromise = null;
      throw err;
    });
  }
  return cachedIndexPromise;
}

/**
 * Runs Infomap community detection on the visible graph nodes and edges.
 * @param {Array<string>} visibleNodes - Array of visible graph node IDs.
 * @param {Array} visibleEdges - Array of [srcIdx, tgtIdx, weight?] or {source, target, weight?}.
 * @param {number} markovTime - Infomap Markov time parameter (default 1).
 * @returns {Promise<{ modules: Array<{ moduleId: number, graphNodeIds: Array<string> }>, codelength: number|null, elapsedMs: number }>}
 */
async function runInfomap(visibleNodes, visibleEdges, markovTime = 1) {
  const t0 = Date.now();
  const nodeIndexToGraphId = new Map();
  const graphIdToNodeIndex = new Map();

  for (let i = 0; i < visibleNodes.length; i++) {
    const gid = String(visibleNodes[i]);
    const idx = i + 1; // Infomap 1-based node IDs
    nodeIndexToGraphId.set(idx, gid);
    graphIdToNodeIndex.set(gid, idx);
  }

  const edgeLines = [];
  for (let i = 0; i < visibleEdges.length; i++) {
    const e = visibleEdges[i];
    let sIdx, tIdx, w;
    if (Array.isArray(e)) {
      sIdx = Number(e[0]) + 1;
      tIdx = Number(e[1]) + 1;
      w = e.length >= 3 ? Number(e[2]) : 1;
    } else if (e && typeof e === "object") {
      sIdx = graphIdToNodeIndex.get(String(e.source ?? e.s));
      tIdx = graphIdToNodeIndex.get(String(e.target ?? e.t));
      w = e.weight !== undefined && e.weight !== null ? Number(e.weight) : 1;
    }

    if (!sIdx || !tIdx || sIdx === tIdx) continue;
    if (!nodeIndexToGraphId.has(sIdx) || !nodeIndexToGraphId.has(tIdx)) continue;

    // Infomap requires strictly positive edge weights
    const weight = Number.isFinite(w) && w > 0 ? w : Number.isFinite(w) && w < 0 ? Math.abs(w) : 1;
    edgeLines.push(`${sIdx} ${tIdx} ${weight}`);
  }

  if (edgeLines.length === 0) {
    return { modules: [], codelength: null, elapsedMs: Date.now() - t0 };
  }

  const networkStr = edgeLines.join("\n");
  const result = await runInfomapWasm(networkStr, {
    args: [
      "--two-level",
      "--flow-model",
      "undirected",
      "--markov-time",
      String(markovTime),
      "--seed",
      "42",
      "--silent",
      "-o",
      "clu",
    ],
  });

  const cluText = result.clu || "";
  let codelength = null;
  const moduleBuckets = new Map();

  const lines = cluText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = line.match(/codelength\s+([0-9.eE+-]+)/i);
      if (m) codelength = parseFloat(m[1]);
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const nodeIdx = parseInt(parts[0], 10);
    const modId = parseInt(parts[1], 10);
    const graphId = nodeIndexToGraphId.get(nodeIdx);
    if (!graphId || !Number.isFinite(modId)) continue;

    let bucket = moduleBuckets.get(modId);
    if (!bucket) {
      bucket = [];
      moduleBuckets.set(modId, bucket);
    }
    bucket.push(graphId);
  }

  const modules = Array.from(moduleBuckets.entries())
    .map(([moduleId, graphNodeIds]) => ({ moduleId, graphNodeIds }))
    .sort((a, b) => b.graphNodeIds.length - a.graphNodeIds.length);

  return {
    modules,
    codelength,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Runs Over-Representation Analysis (ORA) on all Infomap modules and keeps only
 * modules with at least one significantly enriched functional term.
 */
function runOraAcrossModules(modules, options, index, visibleNodes) {
  const {
    backgroundMode = "network",
    customBackground = [],
    annotatedOnly = true,
    pvalThreshold = 0.05,
    minOverlap = 2,
  } = options;

  // Map each visible graph node ID -> canonical DB ID (preserving fallback for unrecognized custom IDs)
  const graphToCanonical = new Map();
  const visibleCanonicalSet = new Set();
  for (const gid of visibleNodes) {
    const gStr = String(gid);
    const canon = resolveGeneId(gStr, index) || gStr;
    graphToCanonical.set(gStr, canon);
    visibleCanonicalSet.add(canon);
  }

  // Construct raw background gene set
  let rawBgSet;
  let customStats = null;
  if (backgroundMode === "none") {
    rawBgSet = index.allGenes;
  } else if (backgroundMode === "custom") {
    rawBgSet = new Set();
    const rawTokens = Array.isArray(customBackground) ? customBackground : [];
    let matchedCount = 0;
    for (const token of rawTokens) {
      const canon = resolveGeneId(token, index);
      if (canon) {
        rawBgSet.add(canon);
        matchedCount++;
      } else {
        const cleaned = String(token || "").trim();
        if (cleaned) rawBgSet.add(cleaned);
      }
    }
    customStats = {
      inputCount: rawTokens.length,
      resolvedUniqueCount: rawBgSet.size,
      matchedDbCount: matchedCount,
    };
  } else {
    // Default: "network" (all genes in the visible network)
    rawBgSet = visibleCanonicalSet;
  }

  // Precompute per-namespace background universe & term sizes (shared across all clusters)
  const nsPrepared = {};
  const backgroundCountsBySource = {};

  for (const src of SOURCES) {
    const ns = index.namespaces[src];
    let universe;
    if (annotatedOnly) {
      universe = new Set();
      if (rawBgSet.size <= ns.annotatedGenes.size) {
        rawBgSet.forEach((g) => {
          if (ns.annotatedGenes.has(g)) universe.add(g);
        });
      } else {
        ns.annotatedGenes.forEach((g) => {
          if (rawBgSet.has(g)) universe.add(g);
        });
      }
    } else {
      universe = rawBgSet;
    }

    const N = universe.size;
    const termBgSizes = new Map();

    if (N >= 2) {
      for (const [termId, termGenes] of ns.termToGenes.entries()) {
        let count = 0;
        if (termGenes.size <= universe.size) {
          termGenes.forEach((g) => {
            if (universe.has(g)) count++;
          });
        } else {
          universe.forEach((g) => {
            if (termGenes.has(g)) count++;
          });
        }
        // Only test terms present in at least 2 background genes and not trivially 100% of background
        if (count >= 2 && count < N) {
          termBgSizes.set(termId, count);
        }
      }
    }

    nsPrepared[src] = {
      ns,
      universe,
      N,
      termBgSizes,
      totalTests: termBgSizes.size,
    };
    backgroundCountsBySource[src] = {
      universeSize: N,
      testedTerms: termBgSizes.size,
    };
  }

  // Evaluate ORA for each Infomap module
  const enrichedClusters = [];

  for (const mod of modules) {
    if (mod.graphNodeIds.length < minOverlap) continue;

    // Map module's graph IDs to canonical IDs (deduplicated) and keep reverse map to graph IDs
    const canonToGraphIds = new Map();
    const moduleCanonSet = new Set();
    for (const gid of mod.graphNodeIds) {
      const canon = graphToCanonical.get(gid) || gid;
      moduleCanonSet.add(canon);
      if (!canonToGraphIds.has(canon)) canonToGraphIds.set(canon, []);
      canonToGraphIds.get(canon).push(gid);
    }

    const significantTerms = [];

    for (const src of SOURCES) {
      const prep = nsPrepared[src];
      if (!prep || prep.N < 2 || prep.totalTests === 0) continue;

      // Intersect cluster with namespace background universe
      const queryGenes = [];
      moduleCanonSet.forEach((g) => {
        if (prep.universe.has(g)) queryGenes.push(g);
      });
      const n = queryGenes.length;
      if (n < minOverlap) continue;

      // Tally overlaps for terms hit by query genes
      const hitMap = new Map(); // termId -> Array<canonicalGeneId>
      for (const g of queryGenes) {
        const gTerms = prep.ns.geneToTerms.get(g);
        if (!gTerms) continue;
        for (let i = 0; i < gTerms.length; i++) {
          const termId = gTerms[i];
          if (!prep.termBgSizes.has(termId)) continue;
          let arr = hitMap.get(termId);
          if (!arr) {
            arr = [];
            hitMap.set(termId, arr);
          }
          arr.push(g);
        }
      }

      if (hitMap.size === 0) continue;

      const hitEntries = [];
      const rawPvals = [];

      for (const [termId, overlapCanonGenes] of hitMap.entries()) {
        const k = overlapCanonGenes.length;
        const M = prep.termBgSizes.get(termId);
        const pRaw = hypergeomUpperTail(k, prep.N, M, n);
        hitEntries.push({ termId, overlapCanonGenes, k, M, pRaw });
        rawPvals.push(pRaw);
      }

      // Benjamini-Hochberg FDR across all tested terms (totalTests) in this source
      const adjPvals = padjust(rawPvals, "bh", prep.totalTests);

      for (let i = 0; i < hitEntries.length; i++) {
        const entry = hitEntries[i];
        const pAdj = adjPvals[i];
        if (entry.k >= minOverlap && pAdj <= pvalThreshold) {
          const meta = prep.ns.termMeta.get(entry.termId) || {
            id: entry.termId,
            name: entry.termId,
            source: src,
          };
          const foldEnrichment =
            entry.M > 0 && n > 0 ? (entry.k / n) / (entry.M / prep.N) : 0;

          // Return graph node IDs for the overlapping genes
          const overlapGraphIds = [];
          for (const cg of entry.overlapCanonGenes) {
            const gids = canonToGraphIds.get(cg);
            if (gids) overlapGraphIds.push(...gids);
          }

          significantTerms.push({
            termId: meta.id,
            name: meta.name,
            source: src,
            overlap: entry.k,
            querySize: n,
            termSize: entry.M,
            backgroundSize: prep.N,
            foldEnrichment: Math.round(foldEnrichment * 1000) / 1000,
            pValue: entry.pRaw,
            pAdj,
            genes: overlapGraphIds,
          });
        }
      }
    }

    if (significantTerms.length === 0) continue;

    significantTerms.sort((a, b) => {
      if (a.pAdj !== b.pAdj) return a.pAdj - b.pAdj;
      if (b.foldEnrichment !== a.foldEnrichment) return b.foldEnrichment - a.foldEnrichment;
      return b.overlap - a.overlap;
    });

    enrichedClusters.push({
      moduleId: mod.moduleId,
      genes: mod.graphNodeIds,
      size: mod.graphNodeIds.length,
      topTerm: significantTerms[0],
      termsCount: significantTerms.length,
      terms: significantTerms,
    });
  }

  // Sort enriched clusters by size descending (tie-breaker: best pAdj ascending)
  enrichedClusters.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return a.topTerm.pAdj - b.topTerm.pAdj;
  });

  // Assign clean default IDs and readable names based on the top enriched term
  const clusters = enrichedClusters.map((c, idx) => ({
    id: `cd_${idx + 1}`,
    moduleId: c.moduleId,
    name: `C${idx + 1} - ${shortClusterLabel(c.topTerm)}`,
    size: c.size,
    genes: c.genes,
    topTerm: c.topTerm,
    termsCount: c.termsCount,
    terms: c.terms,
  }));

  return {
    clusters,
    backgroundSummary: {
      mode: backgroundMode,
      annotatedOnly: !!annotatedOnly,
      rawBackgroundSize: rawBgSet.size,
      customStats,
      bySource: backgroundCountsBySource,
    },
  };
}

/**
 * Full end-to-end Community Discovery + ORA pipeline.
 */
async function runCommunityDiscovery(driver, payload) {
  const tStart = Date.now();
  const visibleNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const visibleEdges = Array.isArray(payload.edges) ? payload.edges : [];

  const markovTime =
    payload.markovTime !== undefined && payload.markovTime !== null
      ? Number(payload.markovTime)
      : 1;
  const pvalThreshold =
    payload.pvalThreshold !== undefined && payload.pvalThreshold !== null
      ? Number(payload.pvalThreshold)
      : 0.05;
  const backgroundMode = ["none", "network", "custom"].includes(payload.backgroundMode)
    ? payload.backgroundMode
    : "network";
  const annotatedOnly =
    payload.annotatedOnly !== undefined ? Boolean(payload.annotatedOnly) : true;
  const customBackground = Array.isArray(payload.customBackground)
    ? payload.customBackground
    : [];

  if (visibleNodes.length < 2 || visibleEdges.length < 1) {
    throw Object.assign(
      new Error("At least 2 visible nodes and 1 visible edge are required for Community Discovery."),
      { statusCode: 400 }
    );
  }
  if (!Number.isFinite(markovTime) || markovTime <= 0 || markovTime > 100) {
    throw Object.assign(
      new Error("Markov time must be a number greater than 0 and at most 100."),
      { statusCode: 400 }
    );
  }
  if (!Number.isFinite(pvalThreshold) || pvalThreshold <= 0 || pvalThreshold > 1) {
    throw Object.assign(
      new Error("Adjusted p-value threshold must be between 0 and 1."),
      { statusCode: 400 }
    );
  }
  if (backgroundMode === "custom" && customBackground.length === 0) {
    throw Object.assign(
      new Error("Custom background mode selected, but no background genes were provided."),
      { statusCode: 400 }
    );
  }

  // Run annotation index loading (cached) and Infomap clustering in parallel!
  const [index, infomapRes] = await Promise.all([
    getAnnotationIndex(driver),
    runInfomap(visibleNodes, visibleEdges, markovTime),
  ]);

  const tOraStart = Date.now();
  const oraRes = runOraAcrossModules(
    infomapRes.modules,
    {
      backgroundMode,
      customBackground,
      annotatedOnly,
      pvalThreshold,
    },
    index,
    visibleNodes
  );

  return {
    clusters: oraRes.clusters,
    stats: {
      visibleNodes: visibleNodes.length,
      visibleEdges: visibleEdges.length,
      totalModulesDetected: infomapRes.modules.length,
      enrichedClustersCount: oraRes.clusters.length,
      codelength: infomapRes.codelength,
      markovTime,
      pvalThreshold,
      goDagPropagated: index.goDagEdgeCount > 0,
      background: oraRes.backgroundSummary,
      timingsMs: {
        infomap: infomapRes.elapsedMs,
        ora: Date.now() - tOraStart,
        total: Date.now() - tStart,
      },
    },
  };
}

/**
 * Runs ORA-only (no Infomap) on pre-defined clusters (e.g., imported clusters from JSON/TSV).
 * Preserves every provided cluster's id, name, color, customColor, and gene list while
 * refreshing its significant ORA terms under the specified p-value threshold and background.
 */
async function runOraForClusters(driver, payload) {
  const tStart = Date.now();
  const visibleNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const inputClusters = Array.isArray(payload.clusters) ? payload.clusters : [];

  const pvalThreshold =
    payload.pvalThreshold !== undefined && payload.pvalThreshold !== null
      ? Number(payload.pvalThreshold)
      : 0.05;
  const backgroundMode = ["none", "network", "custom"].includes(payload.backgroundMode)
    ? payload.backgroundMode
    : "network";
  const annotatedOnly =
    payload.annotatedOnly !== undefined ? Boolean(payload.annotatedOnly) : true;
  const customBackground = Array.isArray(payload.customBackground)
    ? payload.customBackground
    : [];

  if (inputClusters.length === 0) {
    return {
      clusters: [],
      stats: {
        visibleNodes: visibleNodes.length,
        totalModulesDetected: 0,
        enrichedClustersCount: 0,
        pvalThreshold,
        background: { mode: backgroundMode, annotatedOnly, rawBackgroundSize: visibleNodes.length },
        timingsMs: { ora: 0, total: Date.now() - tStart },
      },
    };
  }

  if (!Number.isFinite(pvalThreshold) || pvalThreshold <= 0 || pvalThreshold > 1) {
    throw Object.assign(
      new Error("Adjusted p-value threshold must be between 0 and 1."),
      { statusCode: 400 }
    );
  }

  const index = await getAnnotationIndex(driver);
  const tOraStart = Date.now();

  // Build synthetic Infomap-like module list with unique numeric moduleIds
  const modules = inputClusters.map((c, idx) => ({
    moduleId: idx + 1,
    graphNodeIds: Array.isArray(c.genes) ? c.genes.map(String) : [],
  }));

  const oraRes = runOraAcrossModules(
    modules,
    {
      backgroundMode,
      customBackground,
      annotatedOnly,
      pvalThreshold,
    },
    index,
    visibleNodes
  );

  const enrichedByModId = new Map(oraRes.clusters.map((c) => [c.moduleId, c]));

  // Preserve all imported clusters with their exact saved names/colors/genes, attaching refreshed ORA terms
  const mergedClusters = inputClusters.map((orig, idx) => {
    const modId = idx + 1;
    const enriched = enrichedByModId.get(modId);
    const terms = enriched ? enriched.terms : [];
    const genes = Array.isArray(orig.genes) ? orig.genes.map(String) : [];
    return {
      id: String(orig.id || `imp_${idx + 1}`),
      moduleId: modId,
      name: String(orig.name || (enriched ? enriched.name : `Cluster ${idx + 1}`)),
      color: orig.color || null,
      customColor: orig.customColor !== undefined ? Boolean(orig.customColor) : Boolean(orig.color),
      size: genes.length,
      genes,
      topTerm: terms.length > 0 ? terms[0] : null,
      termsCount: terms.length,
      terms,
    };
  });

  return {
    clusters: mergedClusters,
    stats: {
      visibleNodes: visibleNodes.length,
      totalModulesDetected: inputClusters.length,
      enrichedClustersCount: mergedClusters.filter((c) => c.termsCount > 0).length,
      pvalThreshold,
      goDagPropagated: index.goDagEdgeCount > 0,
      background: oraRes.backgroundSummary,
      timingsMs: {
        ora: Date.now() - tOraStart,
        total: Date.now() - tStart,
      },
    },
  };
}

/**
 * Resolves exact overlapping graph gene IDs for a single (source, termId, clusterGenes) query.
 * Used for lazy gene expansion on DB-stored global clusters without duplicating gene arrays in Neo4j.
 */
async function getOverlapGenesForTerm(driver, payload) {
  const source = String(payload.source || "").trim();
  const termId = String(payload.termId || "").trim();
  const clusterGenes = Array.isArray(payload.clusterGenes) ? payload.clusterGenes : [];

  if (!SOURCES.includes(source) || !termId || clusterGenes.length === 0) {
    return { genes: [] };
  }

  const index = await getAnnotationIndex(driver);
  const ns = index.namespaces[source];
  const termSet = ns && ns.termToGenes.get(termId);
  if (!termSet || termSet.size === 0) {
    return { genes: [] };
  }

  const matched = [];
  for (let i = 0; i < clusterGenes.length; i++) {
    const gid = String(clusterGenes[i]);
    const canon = resolveGeneId(gid, index) || gid;
    if (termSet.has(canon)) matched.push(gid);
  }
  return { genes: matched };
}

module.exports = {
  runCommunityDiscovery,
  runOraForClusters,
  getOverlapGenesForTerm,
  runInfomap,
  runOraAcrossModules,
  hypergeomUpperTail,
  getAnnotationIndex,
  cleanKeggName,
};
