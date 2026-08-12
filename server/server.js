/**
 * server.js - Express Middleware API Server for Neo4j Backend Integration
 * 
 * Provides RESTful API endpoints for streaming initial network topology, fetching
 * regulation edge directions, loading functional gene clusters, querying TF-promoter
 * binding events, and fetching comprehensive node attribute metadata.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const neo4j = require("neo4j-driver");

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ limit: "200mb", extended: true }));

/** Initialize Neo4j Driver Connection */
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
);

/**
 * GET /api/network/init
 * Streams lightweight master network topology (nodes and coexpression edges) as JSON.
 */
app.get("/api/network/init", (req, res) => {
  const session = driver.session();
  res.setHeader("Content-Type", "application/json");
  res.write('{"nodes":[');

  let isFirstNode = true;
  session
    .run(
      `
    MATCH (n:Gene)
    RETURN n.id as id, n.x as x, n.y as y, n.deg as deg, n.type as type, n.symbol as symbol, n.msu_id as msu_id, n.identifier as identifier
  `,
    )
    .subscribe({
      onNext: (record) => {
        if (!isFirstNode) res.write(",");
        res.write(
          JSON.stringify({
            id: record.get("id"),
            x: record.get("x"),
            y: record.get("y"),
            deg: record.get("deg"),
            originalType: record.get("type") || "Gene",
            symbol: record.get("symbol"),
            msu_id: record.get("msu_id"),
            identifier: record.get("identifier"),
            isRogue: record.get("x") === null,
          }),
        );
        isFirstNode = false;
      },
      onCompleted: () => {
        res.write('],"edges":[');
        let isFirstEdge = true;
        session
          .run(
            "MATCH (s:Gene)-[r:INTERACTS_WITH]->(t:Gene) RETURN s.id as s, t.id as t, r.weight as w, r.irp as irp",
          )
          .subscribe({
            onNext: (record) => {
              if (!isFirstEdge) res.write(",");
              res.write(
                JSON.stringify({
                  source: record.get("s"),
                  target: record.get("t"),
                  has_interacts: true,
                  has_regulates: false,
                  weight: record.get("w"),
                  irp: record.get("irp"),
                }),
              );
              isFirstEdge = false;
            },
            onCompleted: () => {
              res.write("]}");
              res.end();
              session.close();
            },
            onError: (err) => {
              console.error("Edge Stream Error:", err);
              res.end();
              session.close();
            },
          });
      },
      onError: (err) => {
        console.error("Node Stream Error:", err);
        res.end();
        session.close();
      },
    });
});

/**
 * POST /api/network/edges/regulates
 * Queries regulation relationship directions (REGULATES) for requested edge pairs.
 */
app.post("/api/network/edges/regulates", async (req, res) => {
  const { pairs } = req.body;

  if (!pairs || !Array.isArray(pairs)) {
    return res.status(400).json({ error: "Invalid edge pairs list." });
  }

  const session = driver.session();
  try {
    const result = await session.run(
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
      WITH pair, collect({src: regulator, tgt: regulated}) AS directions
      RETURN pair.s AS original_s,
             pair.t AS original_t,
             directions
      `,
      { pairs }
    );

    const edges = result.records.map(r => ({
      original_s: r.get("original_s"),
      original_t: r.get("original_t"),
      directions: r.get("directions"),
      has_regulates: true
    }));

    res.json({ edges });
  } catch (error) {
    res.status(500).json({ error: "Regulation query failed.", details: error.message });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/network/edges/binds
 * Fetches detailed TF-promoter binding motif events for a given source -> target pair.
 */
app.get("/api/network/edges/binds", async (req, res) => {
  const { source, target } = req.query;

  if (!source || !target) {
    return res.status(400).json({ error: "Source and target required." });
  }

  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (s:Gene {id: $source})-[:HAS_MOTIF]->(m:Motif)-[b:BINDS]->(t:Gene {id: $target})
      RETURN m.id AS motif_id,
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
      { source, target }
    );

    const binds = result.records.map(r => {
      const sVal = r.get("start");
      const eVal = r.get("stop");
      const occVal = r.get("occurrence");
      return {
        motif_id: r.get("motif_id"),
        motif_source: r.get("motif_source"),
        strand: r.get("strand"),
        score: r.get("score"),
        p_value: r.get("p_value"),
        q_value: r.get("q_value"),
        matched_sequence: r.get("matched_sequence"),
        start: sVal !== null ? (sVal.toNumber ? sVal.toNumber() : sVal) : null,
        stop: eVal !== null ? (eVal.toNumber ? eVal.toNumber() : eVal) : null,
        occurrence: occVal !== null ? (occVal.toNumber ? occVal.toNumber() : occVal) : null
      };
    });

    res.json({ binds });
  } catch (error) {
    res.status(500).json({ error: "Binds query failed." });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/network/clusters
 * Fetches functional cluster module definitions and assigned gene lists.
 */
app.get("/api/network/clusters", async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (c:Cluster)<-[:BELONGS_TO_CLUSTER]-(g:Gene)
      RETURN c.name AS cluster_name, collect(g.id) AS genes
    `);

    const clusters = result.records.map(r => ({
      name: r.get("cluster_name"),
      genes: r.get("genes")
    }));

    res.json({ clusters });
  } catch (error) {
    console.error("Cluster fetch error:", error);
    res.status(500).json({ error: "Failed to fetch clusters." });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/network/node/:id
 * Fetches comprehensive metadata annotations for a single gene node (GO, KEGG, MapMan, UniProt, TF info).
 */
app.get("/api/network/node/:id", async (req, res) => {
  const session = driver.session();
  const nodeId = req.params.id;
  try {
    const result = await session.run(
      `
      MATCH (n:Gene)
      WHERE n.id = $nodeId OR n.msu_id = $nodeId OR n.symbol = $nodeId
      WITH n LIMIT 1
      OPTIONAL MATCH (n)-[:IN_PATHWAY]->(p:Pathway)
      WITH n, collect(DISTINCT {code: p.id, name: p.name}) as pathways
      OPTIONAL MATCH (n)-[:BELONGS_TO_FAMILY]->(f:TFFamily)
      WITH n, pathways, collect(DISTINCT {id: n.tf_id, family: f.name}) as tfDetails
      OPTIONAL MATCH (n)-[:HAS_KO]->(k:KO)
      WITH n, pathways, tfDetails, collect(DISTINCT k.id) as kos
      OPTIONAL MATCH (n)-[:HAS_GO_TERM]->(g:GOTerm)
      WITH n, pathways, tfDetails, kos, collect(DISTINCT {id: g.id, name: g.name, domain: g.domain}) as gos
      OPTIONAL MATCH (n)-[:HAS_MAPMAN]->(m:MapMan)
      OPTIONAL MATCH path=(m)-[:SUBCATEGORY_OF*0..]->(root:MapMan)
      WHERE NOT (root)-[:SUBCATEGORY_OF]->()
      WITH n, pathways, tfDetails, kos, gos,
           collect(DISTINCT [node in nodes(path) | {bincode: node.bincode, name: node.name}]) as mapmanPaths
      OPTIONAL MATCH (n)-[:HAS_UNIPROT]->(u:Uniprot)
      WITH n, pathways, tfDetails, kos, gos, mapmanPaths,
           collect(DISTINCT {entry: u.entry, entry_name: u.entry_name, gene_names: u.gene_names, protein_names: u.protein_names, reviewed: u.reviewed}) as uniprotNodes
      RETURN {
          id: n.id, symbol: n.symbol, msu_id: n.msu_id, identifier: n.identifier, kegg_gene: n.kegg_gene, full_name: n.full_name,
          keggDetail: pathways, tfDetail: tfDetails, mapmanPaths: mapmanPaths, uniprotDetail: uniprotNodes,
          attributes: { KO: kos, GO: gos }
      } as metadata
    `,
      { nodeId },
    );

    if (result.records.length === 0) {
      console.warn(`Node not found in DB: ${nodeId}`);
      return res.status(404).json({ error: "Node not found" });
    }
    res.json(result.records[0].get("metadata"));
  } catch (error) {
    console.error("Metadata Error:", error);
    res.status(500).json({ error: "Metadata fetch failed." });
  } finally {
    await session.close();
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`API Middleware running on port ${PORT}.`));
