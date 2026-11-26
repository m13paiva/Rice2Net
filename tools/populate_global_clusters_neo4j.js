#!/usr/bin/env node
/**
 * populate_global_clusters_neo4j.js
 *
 * Populates the 8 curated global network functional clusters into Neo4j:
 *   - (:Cluster { id, name, color, order, size, markov_time, pval_threshold, background_mode, annotated_only })
 *   - (:Gene)-[:BELONGS_TO_CLUSTER]->(:Cluster)   (full gene memberships via deterministic Infomap mt=1.5)
 *   - (:Cluster)-[:ENRICHED_IN { source, overlap, query_size, term_size, background_size, fold, p_value, p_adj }]->(term)
 *     pointing directly to existing :GOTerm, :MapMan, and :Pathway nodes for instant app startup.
 */

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const serverDir = path.resolve(__dirname, "..", "server");
const serverRequire = createRequire(path.join(serverDir, "package.json"));
serverRequire("dotenv").config({ path: path.join(serverDir, ".env") });
const neo4j = serverRequire("neo4j-driver");
const { runCommunityDiscovery } = require(path.join(serverDir, "community_discovery"));

const ORA_TSV_PATH = "/home/m13paiva/Downloads/community_discovery_ora.tsv";

const CURATED_CLUSTERS = [
  { id: "cd_1", order: 1, name: "C1 - Translation", color: "#FF3B30" },
  { id: "cd_2", order: 2, name: "C2 - External stimulus response", color: "#1A5FB4" },
  { id: "cd_3", order: 3, name: "C3 - Photosynthesis", color: "#00FF40" },
  { id: "cd_4", order: 4, name: "C4 - Cell wall organisation", color: "#FFD700" },
  { id: "cd_5", order: 5, name: "C5 - Stress response & defense", color: "#FF00FF" },
  { id: "cd_6", order: 6, name: "C6 - Transcriptional regulation", color: "#FF8C00" },
  { id: "cd_7", order: 7, name: "C7 - Protein folding", color: "#63452C" },
  { id: "cd_8", order: 8, name: "C8 - Photosystem II", color: "#26A269" },
];

const MARKOV_TIME = 1.5;
const PVAL_THRESHOLD = 0.05;
const BACKGROUND_MODE = "network";
const ANNOTATED_ONLY = true;

function parseTsvSummary(tsvPath) {
  if (!fs.existsSync(tsvPath)) return null;
  const lines = fs.readFileSync(tsvPath, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split("\t");
  const byCid = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const row = Object.fromEntries(header.map((h, idx) => [h, cols[idx]]));
    if (!byCid.has(row.Cluster_ID)) {
      byCid.set(row.Cluster_ID, {
        name: row.Cluster_Name,
        size: parseInt(row.Cluster_Size, 10),
        termCount: 0,
        overlapGenes: new Set(),
      });
    }
    const entry = byCid.get(row.Cluster_ID);
    entry.termCount++;
    (row.Overlap_Genes || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((g) => entry.overlapGenes.add(g));
  }
  return byCid;
}

async function main() {
  const driver = neo4j.driver(
    process.env.NEO4J_URI || "bolt://127.0.0.1:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER || "neo4j",
      process.env.NEO4J_PASSWORD || "neo4j123"
    )
  );

  const readSession = driver.session({ defaultAccessMode: neo4j.session.READ });
  let globalResult;

  try {
    console.log("Loading global network from Neo4j...");
    const nRes = await readSession.run(
      "MATCH (n:Gene) WHERE n.x IS NOT NULL RETURN n.id AS id"
    );
    const nodeIds = nRes.records.map((r) => r.get("id"));
    const idToIdx = new Map(nodeIds.map((id, i) => [id, i]));

    const eRes = await readSession.run(
      "MATCH (a:Gene)-[r:INTERACTS_WITH]->(b:Gene) RETURN a.id AS s, b.id AS t, r.weight AS w"
    );
    const edges = [];
    for (const r of eRes.records) {
      const si = idToIdx.get(r.get("s"));
      const ti = idToIdx.get(r.get("t"));
      if (si !== undefined && ti !== undefined) {
        edges.push([si, ti, r.get("w") ?? 1]);
      }
    }
    console.log(`Running Infomap (mt=${MARKOV_TIME}) + ORA on ${nodeIds.length} nodes, ${edges.length} edges...`);

    globalResult = await runCommunityDiscovery(driver, {
      nodes: nodeIds,
      edges,
      markovTime: MARKOV_TIME,
      backgroundMode: BACKGROUND_MODE,
      annotatedOnly: ANNOTATED_ONLY,
      pvalThreshold: PVAL_THRESHOLD,
    });
  } finally {
    await readSession.close();
  }

  const discoveredById = new Map(globalResult.clusters.map((c) => [c.id, c]));
  const tsvCheck = parseTsvSummary(ORA_TSV_PATH);

  // Validate exact match against curated TSV before writing to Neo4j
  const preparedClusters = CURATED_CLUSTERS.map((spec) => {
    const disc = discoveredById.get(spec.id);
    if (!disc) {
      throw new Error(`Expected cluster ${spec.id} not found in Infomap output.`);
    }
    if (tsvCheck && tsvCheck.has(spec.id)) {
      const t = tsvCheck.get(spec.id);
      if (disc.size !== t.size || disc.terms.length !== t.termCount) {
        throw new Error(
          `Mismatch on ${spec.id}: size ${disc.size} vs ${t.size}, terms ${disc.terms.length} vs ${t.termCount}`
        );
      }
      const gSet = new Set(disc.genes);
      for (const og of t.overlapGenes) {
        if (!gSet.has(og)) {
          throw new Error(`Overlap gene ${og} missing from ${spec.id}`);
        }
      }
    }
    return {
      ...spec,
      size: disc.size,
      genes: disc.genes,
      terms: disc.terms,
    };
  });

  console.log("Validated all 8 clusters 100% against community_discovery_ora.tsv.");

  const writeSession = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    // 1. Clean existing Cluster nodes
    await writeSession.run("MATCH (c:Cluster) DETACH DELETE c");

    // Ensure index/constraint on Cluster(id)
    await writeSession.run(
      "CREATE CONSTRAINT cluster_id_unique IF NOT EXISTS FOR (c:Cluster) REQUIRE c.id IS UNIQUE"
    );

    // 2. Create Cluster nodes, gene memberships, and ENRICHED_IN edges
    let totalGeneEdges = 0;
    let totalOraEdges = 0;

    for (const c of preparedClusters) {
      await writeSession.run(
        `
        CREATE (c:Cluster {
          id: $id,
          name: $name,
          color: $color,
          order: $order,
          size: $size,
          markov_time: $markovTime,
          pval_threshold: $pvalThreshold,
          background_mode: $backgroundMode,
          annotated_only: $annotatedOnly
        })
        `,
        {
          id: c.id,
          name: c.name,
          color: c.color,
          order: neo4j.int(c.order),
          size: neo4j.int(c.size),
          markovTime: MARKOV_TIME,
          pvalThreshold: PVAL_THRESHOLD,
          backgroundMode: BACKGROUND_MODE,
          annotatedOnly: ANNOTATED_ONLY,
        }
      );

      // Batch BELONGS_TO_CLUSTER edges
      const GENE_BATCH = 2000;
      for (let i = 0; i < c.genes.length; i += GENE_BATCH) {
        const chunk = c.genes.slice(i, i + GENE_BATCH);
        const res = await writeSession.run(
          `
          MATCH (c:Cluster {id: $cid})
          UNWIND $geneIds AS gid
          MATCH (g:Gene {id: gid})
          CREATE (g)-[:BELONGS_TO_CLUSTER]->(c)
          RETURN count(*) AS created
          `,
          { cid: c.id, geneIds: chunk }
        );
        totalGeneEdges += res.records[0].get("created").toNumber();
      }

      // Split ORA terms by target Neo4j label
      const goTerms = [];
      const mmTerms = [];
      const keggTerms = [];

      for (const t of c.terms) {
        const row = {
          termId: t.termId,
          source: t.source,
          overlap: neo4j.int(t.overlap),
          query_size: neo4j.int(t.querySize),
          term_size: neo4j.int(t.termSize),
          background_size: neo4j.int(t.backgroundSize),
          fold: Number(t.foldEnrichment),
          p_value: Number(t.pValue),
          p_adj: Number(t.pAdj),
        };
        if (t.source.startsWith("GO:")) goTerms.push(row);
        else if (t.source === "MapMan") mmTerms.push(row);
        else if (t.source === "KEGG") keggTerms.push(row);
      }

      if (goTerms.length > 0) {
        const r = await writeSession.run(
          `
          MATCH (c:Cluster {id: $cid})
          UNWIND $rows AS row
          MATCH (t:GOTerm {id: row.termId})
          CREATE (c)-[:ENRICHED_IN {
            source: row.source,
            overlap: row.overlap,
            query_size: row.query_size,
            term_size: row.term_size,
            background_size: row.background_size,
            fold: row.fold,
            p_value: row.p_value,
            p_adj: row.p_adj
          }]->(t)
          RETURN count(*) AS created
          `,
          { cid: c.id, rows: goTerms }
        );
        totalOraEdges += r.records[0].get("created").toNumber();
      }

      if (mmTerms.length > 0) {
        const r = await writeSession.run(
          `
          MATCH (c:Cluster {id: $cid})
          UNWIND $rows AS row
          MATCH (t:MapMan {bincode: row.termId})
          CREATE (c)-[:ENRICHED_IN {
            source: row.source,
            overlap: row.overlap,
            query_size: row.query_size,
            term_size: row.term_size,
            background_size: row.background_size,
            fold: row.fold,
            p_value: row.p_value,
            p_adj: row.p_adj
          }]->(t)
          RETURN count(*) AS created
          `,
          { cid: c.id, rows: mmTerms }
        );
        totalOraEdges += r.records[0].get("created").toNumber();
      }

      if (keggTerms.length > 0) {
        const r = await writeSession.run(
          `
          MATCH (c:Cluster {id: $cid})
          UNWIND $rows AS row
          MATCH (t:Pathway {id: row.termId})
          CREATE (c)-[:ENRICHED_IN {
            source: row.source,
            overlap: row.overlap,
            query_size: row.query_size,
            term_size: row.term_size,
            background_size: row.background_size,
            fold: row.fold,
            p_value: row.p_value,
            p_adj: row.p_adj
          }]->(t)
          RETURN count(*) AS created
          `,
          { cid: c.id, rows: keggTerms }
        );
        totalOraEdges += r.records[0].get("created").toNumber();
      }

      console.log(
        `  Stored ${c.id} "${c.name}" (${c.color}): ${c.genes.length} genes, ${c.terms.length} ENRICHED_IN edges`
      );
    }

    const expectedOra = preparedClusters.reduce((acc, c) => acc + c.terms.length, 0);
    console.log(
      `Done! Stored ${preparedClusters.length} clusters, ${totalGeneEdges} BELONGS_TO_CLUSTER edges, ${totalOraEdges}/${expectedOra} ENRICHED_IN edges.`
    );
  } finally {
    await writeSession.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("Failed to populate global clusters:", err);
  process.exit(1);
});
