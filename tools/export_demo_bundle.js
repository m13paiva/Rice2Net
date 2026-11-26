#!/usr/bin/env node
/**
 * export_demo_bundle.js
 *
 * Exports a curated subnetwork JSON (default: demo_data/thiamine_demo_net.json)
 * together with all linked Neo4j gene metadata, regulatory directions, and TF-promoter
 * motif binding sites into compact static JSON files under `demo_data/` for the
 * GitHub Pages zero-backend Web Demo.
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

const inputPath =
  process.argv[2] || path.join(repoRoot, "demo_data", "thiamine_demo_net.json");
const outputDir = process.argv[3] || path.join(repoRoot, "demo_data");

function toNum(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") {
    return val.toNumber();
  }
  return val;
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
      `Exporting demo bundle for ${geneIds.length} genes and ${raw.edges.length} edges...`
    );

    // 1. Query full metadata for every gene in the demo subnetwork (exact /api/network/node/:id schema)
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
      { ids: geneIds }
    );

    const metadataById = {};
    metaResult.records.forEach((r) => {
      const id = String(r.get("reqId"));
      const meta = r.get("metadata");
      if (meta) {
        meta.deg = toNum(meta.deg);
        // Strip empty mapmanPaths entries (e.g. [[]] when no MapMan exists)
        if (Array.isArray(meta.mapmanPaths)) {
          meta.mapmanPaths = meta.mapmanPaths.filter(
            (p) => Array.isArray(p) && p.length > 0 && p[0] && p[0].bincode != null
          );
        }
        metadataById[id] = meta;
      }
    });

    console.log(
      `  Fetched metadata for ${Object.keys(metadataById).length}/${geneIds.length} genes`
    );

    // 2. Build compact network.json preserving exact precomputed x/y layout & signed coexpression edges
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

    const demoEdges = raw.edges
      .filter(
        (e) =>
          idSet.has(String(e.source?.id || e.source)) &&
          idSet.has(String(e.target?.id || e.target))
      )
      .map((e) => {
        const edge = {
          source: String(e.source?.id || e.source),
          target: String(e.target?.id || e.target),
          weight: Number(e.weight ?? e.value ?? 1),
          irp: e.irp !== undefined && e.irp !== null ? Number(e.irp) : null,
        };
        if (e.sign) edge.sign = e.sign;
        return edge;
      });

    // 3. Query overlapping REGULATES directions for all demo edges
    const edgePairs = demoEdges.map((e) => ({ s: e.source, t: e.target }));
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
      WITH pair, startNode(r).id AS regulator, endNode(r).id AS regulated
      WITH pair, collect(DISTINCT {src: regulator, tgt: regulated}) AS directions
      RETURN pair.s AS original_s, pair.t AS original_t, directions
      `,
      { pairs: edgePairs }
    );

    const regEdges = [];
    const directedPairsMap = new Map();
    regResult.records.forEach((r) => {
      const dirs = r.get("directions") || [];
      if (dirs.length > 0) {
        regEdges.push({
          original_s: r.get("original_s"),
          original_t: r.get("original_t"),
          directions: dirs,
        });
        dirs.forEach((d) => {
          const key = `${d.src}->${d.tgt}`;
          if (!directedPairsMap.has(key)) {
            directedPairsMap.set(key, { source: d.src, target: d.tgt });
          }
        });
      }
    });

    const directedPairs = Array.from(directedPairsMap.values());
    console.log(
      `  Matched ${regEdges.length} regulated demo edges (${directedPairs.length} directed pairs)`
    );

    // 4. Query supporting HAS_MOTIF -> BINDS motif binding events for every directed pair
    const bindsByPair = {};
    if (directedPairs.length > 0) {
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
        { pairs: directedPairs }
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
    console.log(`  Fetched ${totalBindRows} supporting motif binding events`);

    // 5. Query clusters (empty in current DB since clusters are disabled, kept for schema completeness)
    const clusterResult = await session.run(
      `
      MATCH (c:Cluster)<-[:BELONGS_TO_CLUSTER]-(g:Gene)
      WHERE g.id IN $ids
      RETURN c.name AS name, collect(g.id) AS genes
      `,
      { ids: geneIds }
    );
    const clusters = clusterResult.records.map((r) => ({
      name: r.get("name"),
      genes: r.get("genes"),
    }));

    // 6. Write compact minified JSON files into demo_data/
    fs.mkdirSync(outputDir, { recursive: true });

    const files = {
      "network.json": { nodes: demoNodes, edges: demoEdges },
      "clusters.json": { clusters },
      "metadata.json": metadataById,
      "regulation.json": { edges: regEdges, bindsByPair },
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
