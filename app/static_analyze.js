/**
 * static_analyze.js - Zero-Backend Client-Side Community Discovery (Infomap WASM) & ORA Engine
 *
 * Powers Analyze -> Community Discovery, ORA-only cluster re-analysis (on JSON/TSV import),
 * and ORA term-overlap gene lookup in Static Web Demo Mode (e.g., GitHub Pages / ?demo=1)
 * using the official @mapequation/infomap WebAssembly browser bundle (lazy-loaded on demand)
 * and pre-exported DAG-propagated annotations in `demo_data/ora_annotations.json`.
 */

(function () {
  const SOURCES = ["GO:BP", "GO:MF", "GO:CC", "KEGG", "MapMan"];

  let infomapScriptPromise = null;
  let cachedIndexPromise = null;

  // Lanczos approximation for ln(Gamma(z)), accurate to ~1e-15 for z > 0
  const LANCZOS_COEFFS = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  const HALF_LN_2PI = 0.5 * Math.log(2 * Math.PI);

  function logGamma(z) {
    if (z < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    const g = 7;
    const x = z - 1;
    let a = LANCZOS_COEFFS[0];
    for (let i = 1; i < LANCZOS_COEFFS.length; i++) {
      a += LANCZOS_COEFFS[i] / (x + i);
    }
    const t = x + g + 0.5;
    return HALF_LN_2PI + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  function logChoose(n, k) {
    if (k < 0 || k > n) return -Infinity;
    if (k === 0 || k === n) return 0;
    return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  }

  function hypergeomPmf(k, N, M, n) {
    if (k < Math.max(0, n + M - N) || k > Math.min(M, n)) return 0;
    const logP = logChoose(M, k) + logChoose(N - M, n - k) - logChoose(N, n);
    return Math.exp(logP);
  }

  /**
   * Exact upper-tail hypergeometric p-value: P(X >= k)
   */
  function hypergeomUpperTail(k, N, M, n) {
    if (k <= 0 || N <= 0 || M <= 0 || n <= 0) return 1;
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
   * Benjamini-Hochberg FDR adjustment matching @stdlib/stats-padjust("bh", totalTests).
   */
  function padjustBH(pvals, totalTests) {
    const m = pvals.length;
    if (m === 0) return [];
    const M = Math.max(m, Number(totalTests) || m);
    const indexed = pvals.map((p, i) => ({ p, i }));
    indexed.sort((a, b) => a.p - b.p);

    const out = new Array(m);
    let runningMin = 1;
    for (let rank = m; rank >= 1; rank--) {
      const item = indexed[rank - 1];
      const adj = Math.min(runningMin, (item.p * M) / rank);
      runningMin = adj;
      out[item.i] = adj > 1 ? 1 : adj < 0 ? 0 : adj;
    }
    return out;
  }

  function normalizeKey(val) {
    return String(val || "").trim().toLowerCase();
  }

  function normalizeMsuKey(val) {
    return normalizeKey(val).replace(/^loc_/, "").replace(/\.\d+$/, "");
  }

  function normalizeRapKey(val) {
    return normalizeKey(val).replace(/^(os\d{2})t(\d{7})(-\d+)?$/, "$1g$2");
  }

  function shortClusterLabel(term) {
    if (!term || !term.name) return term?.id || "Enriched cluster";
    let label = String(term.name).trim();
    if (term.source === "MapMan" && label.includes(".")) {
      const parts = label.split(".").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const tail2 = `${parts[parts.length - 2]}: ${parts[parts.length - 1]}`;
        label = tail2.length <= 48 ? tail2 : parts[parts.length - 1];
      }
    }
    if (label.length > 52) {
      label = label.slice(0, 49).trimEnd() + "...";
    }
    return label;
  }

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

  function loadInfomapBrowserBundle() {
    if (typeof window !== "undefined" && window.infomap && window.infomap.Infomap) {
      return Promise.resolve(window.infomap.Infomap);
    }
    if (infomapScriptPromise) return infomapScriptPromise;

    infomapScriptPromise = new Promise((resolve, reject) => {
      if (typeof document === "undefined") {
        reject(new Error("Infomap browser bundle requires a browser environment."));
        return;
      }
      const script = document.createElement("script");
      script.src = "vendor/infomap.umd.js";
      script.async = true;
      script.onload = () => {
        if (window.infomap && window.infomap.Infomap) {
          resolve(window.infomap.Infomap);
        } else {
          infomapScriptPromise = null;
          reject(new Error("Failed to initialize Infomap WebAssembly bundle."));
        }
      };
      script.onerror = () => {
        infomapScriptPromise = null;
        reject(new Error("Failed to load vendor/infomap.umd.js."));
      };
      document.head.appendChild(script);
    });
    return infomapScriptPromise;
  }

  /**
   * Builds an in-memory annotation index from the static `demo_data/ora_annotations.json` payload.
   */
  function hydrateAnnotationIndex(raw) {
    const genes = Array.isArray(raw.genes) ? raw.genes : [];
    const allDemoGenes = new Set(genes);
    const idMap = new Map();
    const msuMap = new Map();

    const registerAlias = (map, key, canonical) => {
      if (!key || key === "." || key === "-" || key === "null" || key === "none") return;
      if (!map.has(key)) map.set(key, canonical);
    };

    for (let i = 0; i < genes.length; i++) {
      const g = String(genes[i]);
      idMap.set(normalizeKey(g), g);
    }

    if (raw.aliases && typeof raw.aliases === "object") {
      Object.entries(raw.aliases).forEach(([canon, info]) => {
        if (!info) return;
        if (info.msu_id) {
          String(info.msu_id)
            .split(/[,;\s]+/)
            .map((x) => x.trim())
            .filter(Boolean)
            .forEach((part) => {
              registerAlias(idMap, normalizeKey(part), canon);
              registerAlias(msuMap, normalizeMsuKey(part), canon);
            });
        }
        if (info.identifier) {
          const k = normalizeKey(info.identifier);
          registerAlias(idMap, k, canon);
          if (k.startsWith("os") && k.length > 3 && !/^os\d{2}[gt]\d+/i.test(k)) {
            registerAlias(idMap, k.slice(2), canon);
          }
        }
        if (info.symbol) {
          const k = normalizeKey(info.symbol);
          registerAlias(idMap, k, canon);
          if (k.startsWith("os") && k.length > 3 && !/^os\d{2}[gt]\d+/i.test(k)) {
            registerAlias(idMap, k.slice(2), canon);
          }
        }
      });
    }

    const namespaces = {};
    for (const src of SOURCES) {
      const srcRaw = (raw.namespaces && raw.namespaces[src]) || {};
      const termToGenes = new Map();
      const geneToTerms = new Map();
      const termMeta = new Map();
      const annotatedGenes = new Set();
      const genomeTermSizes = new Map();

      const termsArr = Array.isArray(srcRaw.terms) ? srcRaw.terms : [];
      for (let i = 0; i < termsArr.length; i++) {
        // Compact tuple: [termId, termName, genomeSize, [geneIdx...]]
        const entry = termsArr[i];
        const termId = String(entry[0]);
        const termName = String(entry[1] || termId);
        const genomeSize = Number(entry[2] || 0);
        const geneIndices = Array.isArray(entry[3]) ? entry[3] : [];

        termMeta.set(termId, { id: termId, name: termName, source: src });
        if (genomeSize > 0) genomeTermSizes.set(termId, genomeSize);

        const gSet = new Set();
        for (let j = 0; j < geneIndices.length; j++) {
          const gid = genes[geneIndices[j]];
          if (!gid) continue;
          gSet.add(gid);
          annotatedGenes.add(gid);
          let tList = geneToTerms.get(gid);
          if (!tList) {
            tList = [];
            geneToTerms.set(gid, tList);
          }
          tList.push(termId);
        }
        termToGenes.set(termId, gSet);
      }

      namespaces[src] = {
        termToGenes,
        geneToTerms,
        termMeta,
        annotatedGenes,
        genomeTermSizes,
        genomeAnnotatedCount: Number(srcRaw.genomeAnnotatedCount || annotatedGenes.size),
        genomeTotalTestsAnnotated: Number(srcRaw.genomeTotalTestsAnnotated || termToGenes.size),
        genomeTotalTestsAll: Number(srcRaw.genomeTotalTestsAll || termToGenes.size),
      };
    }

    return {
      allGenes: allDemoGenes,
      genomeTotalGenes: Number(raw.genomeTotalGenes || allDemoGenes.size),
      goDagPropagated: Boolean(raw.goDagPropagated),
      idMap,
      msuMap,
      namespaces,
    };
  }

  async function loadStaticOraIndex(demoBase) {
    if (!cachedIndexPromise) {
      cachedIndexPromise = fetch(`${demoBase}/ora_annotations.json`)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load demo ORA annotations (${res.status})`);
          return res.json();
        })
        .then(hydrateAnnotationIndex)
        .catch((err) => {
          cachedIndexPromise = null;
          throw err;
        });
    }
    return cachedIndexPromise;
  }

  /**
   * Runs official Infomap WASM in a browser Web Worker on the visible subgraph.
   */
  async function runInfomapBrowser(visibleNodes, visibleEdges, markovTime = 1) {
    const t0 = Date.now();
    const nodeIndexToGraphId = new Map();
    const graphIdToNodeIndex = new Map();

    for (let i = 0; i < visibleNodes.length; i++) {
      const gid = String(visibleNodes[i]);
      const idx = i + 1;
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

      const weight = Number.isFinite(w) && w > 0 ? w : Number.isFinite(w) && w < 0 ? Math.abs(w) : 1;
      edgeLines.push(`${sIdx} ${tIdx} ${weight}`);
    }

    if (edgeLines.length === 0) {
      return { modules: [], codelength: null, elapsedMs: Date.now() - t0 };
    }

    const InfomapClass = await loadInfomapBrowserBundle();
    const infomap = new InfomapClass();
    const networkStr = edgeLines.join("\n");
    const result = await infomap.runAsync({
      network: networkStr,
      args: `--two-level --flow-model undirected --markov-time ${markovTime} --seed 42 --silent -o clu`,
    });

    const cluText = (result && result.clu) || "";
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

    return { modules, codelength, elapsedMs: Date.now() - t0 };
  }

  /**
   * Exact mirror of server/community_discovery.js:runOraAcrossModules.
   * Supports "network", "none" (exact genome-wide background stats), and "custom" backgrounds.
   */
  function runOraAcrossModules(modules, options, index, visibleNodes) {
    const {
      backgroundMode = "network",
      customBackground = [],
      annotatedOnly = true,
      pvalThreshold = 0.05,
      minOverlap = 2,
    } = options;

    const graphToCanonical = new Map();
    const visibleCanonicalSet = new Set();
    for (const gid of visibleNodes) {
      const gStr = String(gid);
      const canon = resolveGeneId(gStr, index) || gStr;
      graphToCanonical.set(gStr, canon);
      visibleCanonicalSet.add(canon);
    }

    const isGenomeBg = backgroundMode === "none";
    let rawBgSet = null;
    let customStats = null;

    if (backgroundMode === "custom") {
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
    } else if (!isGenomeBg) {
      rawBgSet = visibleCanonicalSet;
    }

    const nsPrepared = {};
    const backgroundCountsBySource = {};

    for (const src of SOURCES) {
      const ns = index.namespaces[src];
      let universe = null;
      let N = 0;
      const termBgSizes = new Map();
      let totalTests = 0;

      if (isGenomeBg) {
        N = annotatedOnly ? ns.genomeAnnotatedCount : index.genomeTotalGenes;
        totalTests = annotatedOnly
          ? ns.genomeTotalTestsAnnotated
          : ns.genomeTotalTestsAll;
        if (N >= 2) {
          ns.genomeTermSizes.forEach((gCount, termId) => {
            if (gCount >= 2 && gCount < N) {
              termBgSizes.set(termId, gCount);
            }
          });
        }
      } else {
        if (annotatedOnly) {
          universe = new Set();
          rawBgSet.forEach((g) => {
            if (ns.annotatedGenes.has(g)) universe.add(g);
          });
        } else {
          universe = rawBgSet;
        }
        N = universe.size;
        if (N >= 2) {
          ns.termToGenes.forEach((termGenes, termId) => {
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
            if (count >= 2 && count < N) {
              termBgSizes.set(termId, count);
            }
          });
        }
        totalTests = termBgSizes.size;
      }

      nsPrepared[src] = { ns, universe, isGenomeBg, N, termBgSizes, totalTests };
      backgroundCountsBySource[src] = { universeSize: N, testedTerms: totalTests };
    }

    const enrichedClusters = [];

    for (const mod of modules) {
      if (mod.graphNodeIds.length < minOverlap) continue;

      const canonToGraphIds = new Map();
      const moduleCanonSet = new Set();
      for (const gid of mod.graphNodeIds) {
        const canon = graphToCanonical.get(gid) || resolveGeneId(gid, index) || gid;
        moduleCanonSet.add(canon);
        if (!canonToGraphIds.has(canon)) canonToGraphIds.set(canon, []);
        canonToGraphIds.get(canon).push(gid);
      }

      const significantTerms = [];

      for (const src of SOURCES) {
        const prep = nsPrepared[src];
        if (!prep || prep.N < 2 || prep.totalTests === 0) continue;

        const queryGenes = [];
        moduleCanonSet.forEach((g) => {
          if (prep.isGenomeBg) {
            if (!annotatedOnly || prep.ns.annotatedGenes.has(g)) {
              queryGenes.push(g);
            }
          } else if (prep.universe.has(g)) {
            queryGenes.push(g);
          }
        });

        const n = queryGenes.length;
        if (n < minOverlap) continue;

        const hitMap = new Map();
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
        hitMap.forEach((overlapCanonGenes, termId) => {
          const k = overlapCanonGenes.length;
          const M = prep.termBgSizes.get(termId);
          const pRaw = hypergeomUpperTail(k, prep.N, M, n);
          hitEntries.push({ termId, overlapCanonGenes, k, M, pRaw });
          rawPvals.push(pRaw);
        });

        const adjPvals = padjustBH(rawPvals, prep.totalTests);

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

    enrichedClusters.sort((a, b) => {
      if (b.size !== a.size) return b.size - a.size;
      return a.topTerm.pAdj - b.topTerm.pAdj;
    });

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
        rawBackgroundSize: isGenomeBg ? index.genomeTotalGenes : rawBgSet.size,
        customStats,
        bySource: backgroundCountsBySource,
      },
    };
  }

  async function runCommunityDiscovery(demoBase, payload) {
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
      throw new Error("At least 2 visible nodes and 1 visible edge are required for Community Discovery.");
    }
    if (!Number.isFinite(markovTime) || markovTime <= 0 || markovTime > 100) {
      throw new Error("Markov time must be a number greater than 0 and at most 100.");
    }
    if (!Number.isFinite(pvalThreshold) || pvalThreshold <= 0 || pvalThreshold > 1) {
      throw new Error("Adjusted p-value threshold must be between 0 and 1.");
    }
    if (backgroundMode === "custom" && customBackground.length === 0) {
      throw new Error("Custom background mode selected, but no background genes were provided.");
    }

    const [index, infomapRes] = await Promise.all([
      loadStaticOraIndex(demoBase),
      runInfomapBrowser(visibleNodes, visibleEdges, markovTime),
    ]);

    const tOraStart = Date.now();
    const oraRes = runOraAcrossModules(
      infomapRes.modules,
      { backgroundMode, customBackground, annotatedOnly, pvalThreshold },
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
        goDagPropagated: index.goDagPropagated,
        background: oraRes.backgroundSummary,
        timingsMs: {
          infomap: infomapRes.elapsedMs,
          ora: Date.now() - tOraStart,
          total: Date.now() - tStart,
        },
      },
    };
  }

  async function runOra(demoBase, payload) {
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

    const index = await loadStaticOraIndex(demoBase);
    const tOraStart = Date.now();

    const modules = inputClusters.map((c, idx) => ({
      moduleId: idx + 1,
      graphNodeIds: Array.isArray(c.genes) ? c.genes.map(String) : [],
    }));

    const oraRes = runOraAcrossModules(
      modules,
      { backgroundMode, customBackground, annotatedOnly, pvalThreshold },
      index,
      visibleNodes
    );

    const enrichedByModId = new Map(oraRes.clusters.map((c) => [c.moduleId, c]));

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
        goDagPropagated: index.goDagPropagated,
        background: oraRes.backgroundSummary,
        timingsMs: { ora: Date.now() - tOraStart, total: Date.now() - tStart },
      },
    };
  }

  async function getTermGenes(demoBase, payload) {
    const source = String(payload.source || "").trim();
    const termId = String(payload.termId || "").trim();
    const clusterGenes = Array.isArray(payload.clusterGenes) ? payload.clusterGenes : [];
    if (!SOURCES.includes(source) || !termId || clusterGenes.length === 0) {
      return { genes: [] };
    }

    const index = await loadStaticOraIndex(demoBase);
    const ns = index.namespaces[source];
    const termSet = ns && ns.termToGenes.get(termId);
    if (!termSet || termSet.size === 0) return { genes: [] };

    const matched = [];
    for (let i = 0; i < clusterGenes.length; i++) {
      const gid = String(clusterGenes[i]);
      const canon = resolveGeneId(gid, index) || gid;
      if (termSet.has(canon)) matched.push(gid);
    }
    return { genes: matched };
  }

  const exported = {
    runCommunityDiscovery,
    runOra,
    getTermGenes,
    hydrateAnnotationIndex,
    runOraAcrossModules,
    hypergeomUpperTail,
    padjustBH,
  };

  if (typeof window !== "undefined") {
    window.RICE2NET_STATIC_ANALYZE = exported;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})();
