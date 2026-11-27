#!/usr/bin/env node
/**
 * export_demo_bundle.js
 *
 * Exports a curated subnetwork JSON (default: /home/m13paiva/Downloads/new_demo_net.json)
 * together with all linked Neo4j gene metadata, source-tagged regulatory directions,
 * TF-promoter motif binding sites, DAG-propagated ORA annotations, and precomputed
 * default-view Community Discovery clusters into compact static JSON files under `demo_data/`
 * so every Rice2Net v2.0.0 feature works in zero-backend Static Web Demo Mode.
 *
 * Usage:
 *   node tools/export_demo_bundle.js [input_network.json] [output_dir]
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const serverNodeModules = path.join(repoRoot, "server", "node_modules");
require(path.join(serverNodeModules, "dotenv")).config({
  path: path.join(repoRoot, "server", ".env"),
});
const neo4j = require(path.join(serverNodeModules, "neo4j-driver"));
const {
  getAnnotationIndex,
  runCommunityDiscovery,
} = require(path.join(repoRoot, "server", "community_discovery"));

const inputPath =
  process.argv[2] || "/home/m13paiva/Downloads/new_demo_net.json";
const outputDir = process.argv[3] || path.join(repoRoot, "demo_data");

const SOURCES = ["GO:BP", "GO:MF", "GO:CC", "KEGG", "MapMan"];
const DEFAULT_CLUSTER_PALETTE = [
  "#FF3B30",
  "#1A5FB4",
  "#00FF40",
  "#FFD700",
  "#FF00FF",
  "#FF8C00",
  "#63452C",
  "#26A269",
  "#00FFFF",
  "#B026FF",
  "#ADFF2F",
  "#FF69B4",
];

function toNum(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") {
    return val.toNumber();
  }
  return val;
}

function isTrueProp(v) {
  return v === true || v === "TRUE" || v === "true" || v === 1;
}

async function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input network JSON not found: ${inputPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error("Input JSON must contain `nodes` and `edges` arrays.");
  }

  const geneIds = raw.nodes.map((n) => String(n.rap_id || n.id));
  const idSet = new Set(geneIds);

  const driver = neo4j.driver(
    process.env.NEO4J_URI || "bolt://127.0.0.1:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER || "neo4j",
      process.env.NEO4J_PASSWORD || "neo4j123"
    )
  );

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });

  try {
    console.log(
      `Exporting v2.0.0 demo bundle for ${geneIds.length} genes and ${raw.edges.length} edges...`
    );

    // 1. Batched metadata export for every gene in the demo subnetwork
    const metadataById = {};
    const META_BATCH = 200;
    for (let i = 0; i < geneIds.length; i += META_BATCH) {
      const batch = geneIds.slice(i, i + META_BATCH);
      const metaResult = await session.run(
        `
        UNWIND $ids AS reqId
        MATCH (n:Gene {id: reqId})
        OPTIONAL MATCH (n)-[:IN_PATHWAY]->(p:Pathway)
        WITH reqId, n, collect(DISTINCT {code: p.id, name: p.name}) AS pathways
        OPTIONAL MATCH (n)-[:BELONGS_TO_FAMILY]->(f:TFFamily)
        WITH reqId, n, pathways, collect(DISTINCT {id: n.tf_id, family: f.name}) AS tfDetails
        OPTIONAL MATCH (n)-[:HAS_GO_TERM]->(g:GOTerm)
        WITH reqId, n, pathways, tfDetails, collect(DISTINCT {id: g.id, name: g.name, domain: g.domain}) AS gos
        OPTIONAL MATCH (n)-[:HAS_MAPMAN]->(m:MapMan)
        OPTIONAL MATCH path=(m)-[:SUBCATEGORY_OF*0..]->(root:MapMan)
        WHERE NOT (root)-[:SUBCATEGORY_OF]->()
        WITH reqId, n, pathways, tfDetails, gos,
             collect(DISTINCT [node IN nodes(path) | {bincode: node.bincode, name: node.name}]) AS mapmanPaths
        OPTIONAL MATCH (n)-[:HAS_UNIPROT]->(u:Uniprot)
        WITH reqId, n, pathways, tfDetails, gos, mapmanPaths,
             collect(DISTINCT {entry: u.entry, entry_name: u.entry_name, gene_names: u.gene_names, protein_names: u.protein_names, reviewed: u.reviewed}) AS uniprotNodes
        OPTIONAL MATCH (n)-[:HAS_MOTIF]->(m:Motif)
        WITH reqId, n, pathways, tfDetails, gos, mapmanPaths, uniprotNodes,
             collect(DISTINCT {id: m.id, source: m.source}) AS motifs
        OPTIONAL MATCH (n)-[:BELONGS_TO_CLUSTER]->(c:Cluster)
        WITH reqId, n, pathways, tfDetails, gos, mapmanPaths, uniprotNodes, motifs,
             collect(DISTINCT c.name) AS clusters
        RETURN reqId, {
          id: n.id,
          symbol: n.symbol,
          msu_id: n.msu_id,
          identifier: n.identifier,
          deg: n.deg,
          type: n.type,
          full_name: n.full_name,
          description: n.full_name,
          kegg_gene: n.kegg_gene,
          keggDetail: [k IN pathways WHERE k.code IS NOT NULL],
          pathways: [k IN pathways WHERE k.code IS NOT NULL],
          tfDetail: [tf IN tfDetails WHERE tf.id IS NOT NULL OR tf.family IS NOT NULL],
          tf_families: [tf IN tfDetails WHERE tf.family IS NOT NULL | tf.family],
          attributes: { GO: [g IN gos WHERE g.id IS NOT NULL] },
          ontologies: [g IN gos WHERE g.id IS NOT NULL | { id: g.id, name: g.name }],
          mapmanPaths: mapmanPaths,
          uniprotDetail: [u IN uniprotNodes WHERE u.entry IS NOT NULL],
          motifs: [m IN motifs WHERE m.id IS NOT NULL],
          clusters: clusters
        } AS metadata
        `,
        { ids: batch }
      );

      metaResult.records.forEach((r) => {
        const id = String(r.get("reqId"));
        const meta = r.get("metadata");
        if (meta) {
          meta.deg = toNum(meta.deg);
          if (Array.isArray(meta.mapmanPaths)) {
            meta.mapmanPaths = meta.mapmanPaths.filter(
              (p) => Array.isArray(p) && p.length > 0 && p[0] && p[0].bincode != null
            );
          }
          metadataById[id] = meta;
        }
      });
    }
    console.log(
      `  [1/5] Fetched metadata for ${Object.keys(metadataById).length}/${geneIds.length} genes`
    );

    // 2. Build compact-v1 network.json preserving exact precomputed x/y layout, z_score & sign
    const demoNodes = raw.nodes.map((n) => {
      const id = String(n.rap_id || n.id);
      const dbMeta = metadataById[id] || {};
      return {
        id,
        x: Math.round(Number(n.x) * 100) / 100,
        y: Math.round(Number(n.y) * 100) / 100,
        deg: Math.round(Number(n.deg || 0)),
        originalType: n.originalType || dbMeta.type || "Gene",
        symbol: dbMeta.symbol != null ? dbMeta.symbol : n.symbol || "",
        msu_id: dbMeta.msu_id != null ? dbMeta.msu_id : n.msu_id || "",
        identifier:
          dbMeta.identifier != null ? dbMeta.identifier : n.identifier || "",
        isRogue: !!n.isRogue,
      };
    });

    const nodeIdxById = new Map();
    demoNodes.forEach((n, idx) => nodeIdxById.set(n.id, idx));

    const demoEdgesObj = [];
    const compactEdges = [];
    for (const e of raw.edges) {
      const s = String(e.source?.id || e.source);
      const t = String(e.target?.id || e.target);
      const sIdx = nodeIdxById.get(s);
      const tIdx = nodeIdxById.get(t);
      if (sIdx === undefined || tIdx === undefined) continue;

      const w = Number(e.weight ?? e.value ?? 1);
      const z =
        e.z_score !== undefined && e.z_score !== null && Number.isFinite(Number(e.z_score))
          ? Number(e.z_score)
          : null;
      const sign = e.sign === "+" || e.sign === "-" ? e.sign : null;
      const signCode = sign === "+" ? 1 : sign === "-" ? -1 : 0;

      demoEdgesObj.push({ source: s, target: t, weight: w, z_score: z, sign });
      compactEdges.push([sIdx, tIdx, w, z, signCode]);
    }
    console.log(
      `  [2/5] Prepared compact-v1 topology (${demoNodes.length} nodes, ${compactEdges.length} edges)`
    );

    // 3. Query overlapping REGULATES directions WITH 4 motif source boolean flags in batches
    const edgePairs = demoEdgesObj.map((e) => ({ s: e.source, t: e.target }));
    const regEdges = [];
    const directedPairsMap = new Map();
    const REG_BATCH = 5000;

    for (let i = 0; i < edgePairs.length; i += REG_BATCH) {
      const batch = edgePairs.slice(i, i + REG_BATCH);
      const regResult = await session.run(
        `
        UNWIND $pairs AS pair
        MATCH (a:Gene {id: pair.s}), (b:Gene {id: pair.t})
        OPTIONAL MATCH (a)-[r1:REGULATES]->(b)
        OPTIONAL MATCH (b)-[r2:REGULATES]->(a)
        WITH pair, r1, r2
        WHERE r1 IS NOT NULL OR r2 IS NOT NULL
        WITH pair, [r IN [r1, r2] WHERE r IS NOT NULL] AS valid_rels
        UNWIND valid_rels AS r
        WITH pair,
             startNode(r).id AS regulator,
             endNode(r).id AS regulated,
             r.PlantTFDB AS ptfdb,
             r.JASPAR_Core AS jcore,
             r.JASPAR_Unvalidated AS junval,
             r.CIS_BP AS cisbp
        RETURN pair.s AS original_s,
               pair.t AS original_t,
               collect(DISTINCT {
                 src: regulator,
                 tgt: regulated,
                 ptfdb: ptfdb,
                 jcore: jcore,
                 junval: junval,
                 cisbp: cisbp
               }) AS directions
        `,
        { pairs: batch }
      );

      regResult.records.forEach((r) => {
        const rawDirs = r.get("directions") || [];
        const dirMap = new Map();
        rawDirs.forEach((d) => {
          if (!d || !d.src || !d.tgt) return;
          const key = `${d.src}->${d.tgt}`;
          let entry = dirMap.get(key);
          if (!entry) {
            entry = { src: d.src, tgt: d.tgt, sources: new Set() };
            dirMap.set(key, entry);
          }
          if (isTrueProp(d.ptfdb)) entry.sources.add("PlantTFDB");
          if (isTrueProp(d.jcore)) entry.sources.add("JASPAR Core");
          if (isTrueProp(d.junval)) entry.sources.add("JASPAR Unvalidated");
          if (isTrueProp(d.cisbp)) entry.sources.add("CIS-BP");
          if (!directedPairsMap.has(key)) {
            directedPairsMap.set(key, { source: d.src, target: d.tgt });
          }
        });

        const dirs = Array.from(dirMap.values()).map((e) => ({
          src: e.src,
          tgt: e.tgt,
          sources: Array.from(e.sources),
        }));
        if (dirs.length > 0) {
          regEdges.push({
            original_s: r.get("original_s"),
            original_t: r.get("original_t"),
            directions: dirs,
          });
        }
      });
    }

    const directedPairs = Array.from(directedPairsMap.values());
    const bindsByPair = {};
    const BINDS_BATCH = 500;
    for (let i = 0; i < directedPairs.length; i += BINDS_BATCH) {
      const batch = directedPairs.slice(i, i + BINDS_BATCH);
      const bindsResult = await session.run(
        `
        UNWIND $pairs AS pair
        MATCH (s:Gene {id: pair.source})-[:HAS_MOTIF]->(m:Motif)-[b:BINDS]->(t:Gene {id: pair.target})
        RETURN pair.source AS source,
               pair.target AS target,
               m.id AS motif_id,
               m.source AS motif_source,
               b.strand AS strand,
               b.score AS score,
               b.p_value AS p_value,
               b.q_value AS q_value,
               b.matched_sequence AS matched_sequence,
               b.start AS start,
               b.stop AS stop,
               b.occurrence AS occurrence
        `,
        { pairs: batch }
      );

      bindsResult.records.forEach((r) => {
        const key = `${r.get("source")}->${r.get("target")}`;
        if (!bindsByPair[key]) bindsByPair[key] = [];
        bindsByPair[key].push({
          motif_id: r.get("motif_id"),
          motif_source: r.get("motif_source"),
          strand: r.get("strand"),
          score: r.get("score"),
          p_value: r.get("p_value"),
          q_value: r.get("q_value"),
          matched_sequence: r.get("matched_sequence"),
          start: toNum(r.get("start")),
          stop: toNum(r.get("stop")),
          occurrence: toNum(r.get("occurrence")),
        });
      });
    }

    const totalBindRows = Object.values(bindsByPair).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    console.log(
      `  [3/5] Matched ${regEdges.length} regulated edges (${directedPairs.length} directed pairs, ${totalBindRows} binding events)`
    );

    // 4. Export compact DAG-propagated ORA annotations + exact genome-wide background stats
    const annoIndex = await getAnnotationIndex(driver);
    const demoGeneIndex = new Map();
    geneIds.forEach((gid, idx) => demoGeneIndex.set(gid, idx));

    const aliases = {};
    for (const gid of geneIds) {
      const meta = metadataById[gid];
      if (!meta) continue;
      const entry = {};
      if (meta.msu_id && meta.msu_id !== ".") entry.msu_id = meta.msu_id;
      if (meta.identifier && meta.identifier !== "." && meta.identifier !== gid) {
        entry.identifier = meta.identifier;
      }
      if (meta.symbol && meta.symbol !== "." && meta.symbol !== gid) {
        entry.symbol = meta.symbol;
      }
      if (Object.keys(entry).length > 0) aliases[gid] = entry;
    }

    const oraNamespaces = {};
    const genomeTotalGenes = annoIndex.allGenes.size;

    for (const src of SOURCES) {
      const ns = annoIndex.namespaces[src];
      const genomeAnnotatedCount = ns.annotatedGenes.size;

      // Exact genome-wide total tested terms (same count >= 2 && count < N rule as backend)
      let genomeTotalTestsAnnotated = 0;
      let genomeTotalTestsAll = 0;
      ns.termToGenes.forEach((gSet) => {
        const sz = gSet.size;
        if (sz >= 2 && sz < genomeAnnotatedCount) genomeTotalTestsAnnotated++;
        if (sz >= 2 && sz < genomeTotalGenes) genomeTotalTestsAll++;
      });

      const terms = [];
      ns.termToGenes.forEach((gSet, termId) => {
        const hitIndices = [];
        for (const gid of geneIds) {
          if (gSet.has(gid)) hitIndices.push(demoGeneIndex.get(gid));
        }
        if (hitIndices.length === 0) return;
        const meta = ns.termMeta.get(termId);
        terms.push([
          termId,
          (meta && meta.name) || termId,
          gSet.size,
          hitIndices,
        ]);
      });

      oraNamespaces[src] = {
        genomeAnnotatedCount,
        genomeTotalTestsAnnotated,
        genomeTotalTestsAll,
        terms,
      };
    }

    const oraAnnotationsPayload = {
      genomeTotalGenes,
      goDagPropagated: annoIndex.goDagEdgeCount > 0,
      genes: geneIds,
      aliases,
      namespaces: oraNamespaces,
    };
    console.log(
      `  [4/5] Prepared DAG-propagated ORA annotations across ${SOURCES.map(
        (s) => `${s}:${oraNamespaces[s].terms.length}`
      ).join(", ")}`
    );

    // 5. Precompute Community Discovery + ORA clusters on default visible demo view (z >= 1.28)
    const defaultEdges = demoEdgesObj.filter(
      (e) => e.z_score === null || e.z_score >= 1.28
    );
    const connectedDefaultSet = new Set();
    defaultEdges.forEach((e) => {
      connectedDefaultSet.add(e.source);
      connectedDefaultSet.add(e.target);
    });
    const visibleDefaultNodes = geneIds.filter((id) => connectedDefaultSet.has(id));
    const visIdx = new Map(visibleDefaultNodes.map((id, i) => [id, i]));
    const visibleDefaultEdges = defaultEdges.map((e) => [
      visIdx.get(e.source),
      visIdx.get(e.target),
      e.weight,
    ]);

    const cdRes = await runCommunityDiscovery(driver, {
      nodes: visibleDefaultNodes,
      edges: visibleDefaultEdges,
      markovTime: 1,
      backgroundMode: "network",
      annotatedOnly: true,
      pvalThreshold: 0.05,
    });

    const clustersPayload = {
      meta: {
        markovTime: 1,
        pvalThreshold: 0.05,
        backgroundMode: "network",
        annotatedOnly: true,
        zScoreThreshold: 1.28,
      },
      clusters: cdRes.clusters.map((c, idx) => ({
        id: c.id,
        name: c.name,
        color: DEFAULT_CLUSTER_PALETTE[idx % DEFAULT_CLUSTER_PALETTE.length],
        size: c.size,
        genes: c.genes,
        topTerm: c.topTerm
          ? {
              termId: c.topTerm.termId,
              name: c.topTerm.name,
              source: c.topTerm.source,
              overlap: c.topTerm.overlap,
              querySize: c.topTerm.querySize,
              termSize: c.topTerm.termSize,
              backgroundSize: c.topTerm.backgroundSize,
              foldEnrichment: c.topTerm.foldEnrichment,
              pValue: c.topTerm.pValue,
              pAdj: c.topTerm.pAdj,
            }
          : null,
        termsCount: c.termsCount,
        terms: c.terms.map((t) => ({
          termId: t.termId,
          name: t.name,
          source: t.source,
          overlap: t.overlap,
          querySize: t.querySize,
          termSize: t.termSize,
          backgroundSize: t.backgroundSize,
          foldEnrichment: t.foldEnrichment,
          pValue: t.pValue,
          pAdj: t.pAdj,
        })),
      })),
    };
    console.log(
      `  [5/5] Precomputed ${clustersPayload.clusters.length} enriched demo clusters (from ${cdRes.stats.totalModulesDetected} Infomap modules on ${visibleDefaultNodes.length} genes / ${visibleDefaultEdges.length} edges at z>=1.28)`
    );

    // 6. Write compact minified JSON files into demo_data/
    fs.mkdirSync(outputDir, { recursive: true });

    const files = {
      "network.json": { format: "compact-v1", nodes: demoNodes, edges: compactEdges },
      "clusters.json": clustersPayload,
      "metadata.json": metadataById,
      "regulation.json": { edges: regEdges, bindsByPair },
      "ora_annotations.json": oraAnnotationsPayload,
    };

    let totalBytes = 0;
    for (const [name, payload] of Object.entries(files)) {
      const outPath = path.join(outputDir, name);
      const serialized = JSON.stringify(payload);
      fs.writeFileSync(outPath, serialized, "utf8");
      const bytes = Buffer.byteLength(serialized, "utf8");
      totalBytes += bytes;
      console.log(`  Wrote ${outPath} (${(bytes / 1024).toFixed(1)} KB)`);
    }

    console.log(
      `Demo bundle export complete! Total size: ${(
        totalBytes /
        (1024 * 1024)
      ).toFixed(2)} MB`
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
