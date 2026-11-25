/**
 * server.js - Express Middleware API Server for Neo4j Backend Integration
 * Production configuration with Nginx reverse proxy support, Helmet, CORS, and Rate Limiting.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const neo4j = require("neo4j-driver");

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Trust Reverse Proxy (Nginx) to accurately retrieve client IP addresses
app.set("trust proxy", 1);

// 2. Security Headers
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// 3. CORS Policy (Standard HTTP Port 80 and backward compatibility)
const allowedOrigins = [
  "http://localhost",
  "http://127.0.0.1",
  "http://192.168.64.3",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://192.168.64.3:8000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin not allowed by CORS policy: ${origin}`));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// 4. Payload Size Limits
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ limit: "2mb", extended: true }));

// 5. Rate Limiting Configuration
const standardLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.RATE_LIMIT_STANDARD_MAX, 10) || 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in 1 minute." },
});

const heavyQueryLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_HEAVY_MAX, 10) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Network loading rate limit exceeded for this IP." },
});

app.use("/api/", standardLimiter);

// 6. Neo4j Driver Setup
const driver = neo4j.driver(
  process.env.NEO4J_URI || "bolt://127.0.0.1:7687",
  neo4j.auth.basic(
    process.env.NEO4J_USER || "neo4j",
    process.env.NEO4J_PASSWORD || "neo4j123"
  ),
  {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 5000,
  }
);

// Strict regex identifier validation to prevent Cypher injection
const isValidIdentifier = (id) => {
  if (typeof id !== "string") return false;
  return /^[a-zA-Z0-9_\.\:\-]{1,128}$/.test(id.trim());
};

/**
 * GET /api/network/init
 * Streams all nodes and baseline interactome edges to avoid memory bottlenecks.
 */
app.get("/api/network/init", heavyQueryLimiter, (req, res) => {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  let isClosed = false;

  const cleanup = async () => {
    if (!isClosed) {
      isClosed = true;
      try {
        await session.close();
      } catch (err) {
        console.error("Error closing Neo4j session:", err);
      }
    }
  };

  req.on("close", cleanup);

  res.setHeader("Content-Type", "application/json");
  res.write('{"nodes":[');

  let isFirstNode = true;
  session
    .run(
      `
      MATCH (n:Gene)
      RETURN n.id as id, n.x as x, n.y as y, n.deg as deg, n.type as type, n.symbol as symbol, n.msu_id as msu_id, n.identifier as identifier
      `
    )
    .subscribe({
      onNext: (record) => {
        if (isClosed) return;
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
          })
        );
        isFirstNode = false;
      },
      onCompleted: () => {
        if (isClosed) return;
        res.write('],"edges":[');
        let isFirstEdge = true;
        session
          .run(
            `
            MATCH (s:Gene)-[r:INTERACTS_WITH]->(t:Gene)
            RETURN s.id as s, t.id as t, r.weight as w, r.irp as irp, r.sign as sign
            `
          )
          .subscribe({
            onNext: (record) => {
              if (isClosed) return;
              if (!isFirstEdge) res.write(",");
              res.write(
                JSON.stringify({
                  source: record.get("s"),
                  target: record.get("t"),
                  has_interacts: true,
                  has_regulates: false,
                  weight: record.get("w"),
                  irp: record.get("irp"),
                  sign: record.get("sign") || null,
                })
              );
              isFirstEdge = false;
            },
            onCompleted: async () => {
              if (!isClosed) {
                res.write("]}");
                res.end();
              }
              await cleanup();
            },
            onError: async (err) => {
              console.error("Edge Stream Error:", err);
              if (!res.headersSent) res.status(500).json({ error: "Edge streaming failed." });
              else res.end();
              await cleanup();
            },
          });
      },
      onError: async (err) => {
        console.error("Node Stream Error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Node streaming failed." });
        else res.end();
        await cleanup();
      },
    });
});

/**
 * POST /api/network/edges/regulates
 * Queries regulation relationships between gene pairs.
 */
app.post("/api/network/edges/regulates", async (req, res) => {
  const { pairs } = req.body;

  if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: "Invalid edge pairs list provided." });
  }

  const validPairs = pairs.filter(
    (p) => p && isValidIdentifier(p.s) && isValidIdentifier(p.t)
  );

  if (validPairs.length === 0) {
    return res.status(400).json({ error: "No valid identifier pairs provided." });
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
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
      { pairs: validPairs }
    );

    const edges = result.records.map((r) => ({
      original_s: r.get("original_s"),
      original_t: r.get("original_t"),
      directions: r.get("directions"),
      has_regulates: true,
    }));

    res.json({ edges });
  } catch (error) {
    console.error("Regulation query error:", error);
    res.status(500).json({ error: "Failed to query regulation relationships." });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/network/edges/binds
 * Fetches motif binding information between source and target genes.
 */
app.get("/api/network/edges/binds", async (req, res) => {
  const { source, target } = req.query;

  if (!source || !target || !isValidIdentifier(source) || !isValidIdentifier(target)) {
    return res.status(400).json({ error: "Valid source and target identifiers are required." });
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
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

    const binds = result.records.map((r) => {
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
        occurrence: occVal !== null ? (occVal.toNumber ? occVal.toNumber() : occVal) : null,
      };
    });

    res.json({ binds });
  } catch (error) {
    console.error("Binds query error:", error);
    res.status(500).json({ error: "Failed to query motif binding data." });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/network/edges/binds
 * Fetches motif binding information for a batch of directed source->target pairs.
 */
app.post("/api/network/edges/binds", async (req, res) => {
  const { pairs } = req.body;

  if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: "Invalid edge pairs list provided." });
  }

  const validPairs = pairs
    .filter(
      (p) =>
        p &&
        isValidIdentifier(p.source || p.s) &&
        isValidIdentifier(p.target || p.t)
    )
    .slice(0, 1000)
    .map((p) => ({
      source: String(p.source || p.s).trim(),
      target: String(p.target || p.t).trim(),
    }));

  if (validPairs.length === 0) {
    return res.status(400).json({ error: "No valid identifier pairs provided." });
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
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
      { pairs: validPairs }
    );

    const bindsByPair = {};
    result.records.forEach((r) => {
      const src = r.get("source");
      const tgt = r.get("target");
      const key = `${src}->${tgt}`;
      if (!bindsByPair[key]) bindsByPair[key] = [];

      const sVal = r.get("start");
      const eVal = r.get("stop");
      const occVal = r.get("occurrence");

      bindsByPair[key].push({
        motif_id: r.get("motif_id"),
        motif_source: r.get("motif_source"),
        strand: r.get("strand"),
        score: r.get("score"),
        p_value: r.get("p_value"),
        q_value: r.get("q_value"),
        matched_sequence: r.get("matched_sequence"),
        start: sVal !== null ? (sVal.toNumber ? sVal.toNumber() : sVal) : null,
        stop: eVal !== null ? (eVal.toNumber ? eVal.toNumber() : eVal) : null,
        occurrence: occVal !== null ? (occVal.toNumber ? occVal.toNumber() : occVal) : null,
      });
    });

    res.json({ bindsByPair });
  } catch (error) {
    console.error("Batch binds query error:", error);
    res.status(500).json({ error: "Failed to query motif binding data in batch." });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/network/clusters
 * Returns functional cluster definitions and assigned genes.
 */
app.get("/api/network/clusters", async (req, res) => {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(`
      MATCH (c:Cluster)<-[:BELONGS_TO_CLUSTER]-(g:Gene)
      RETURN c.name AS cluster_name, collect(g.id) AS genes
    `);

    const clusters = result.records.map((r) => ({
      name: r.get("cluster_name"),
      genes: r.get("genes"),
    }));

    res.json({ clusters });
  } catch (error) {
    console.error("Cluster fetch error:", error);
    res.status(500).json({ error: "Failed to retrieve functional clusters." });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/network/node/:id
 * Fetches comprehensive metadata and biological annotations for a single gene.
 * Traverses Gene Ontology (GOTerm), MapMan hierarchy, UniProt, KEGG pathways, TF families, and Clusters.
 */
app.get("/api/network/node/:id", async (req, res) => {
  const nodeId = req.params.id;

  if (!isValidIdentifier(nodeId)) {
    return res.status(400).json({ error: "Invalid gene identifier." });
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `
      MATCH (n:Gene)
      WHERE n.id = $nodeId OR n.msu_id = $nodeId OR n.symbol = $nodeId OR n.identifier = $nodeId
      WITH n LIMIT 1
      OPTIONAL MATCH (n)-[:IN_PATHWAY]->(p:Pathway)
      WITH n, collect(DISTINCT {code: p.id, name: p.name}) as pathways
      OPTIONAL MATCH (n)-[:BELONGS_TO_FAMILY]->(f:TFFamily)
      WITH n, pathways, collect(DISTINCT {id: n.tf_id, family: f.name}) as tfDetails
      OPTIONAL MATCH (n)-[:HAS_GO_TERM]->(g:GOTerm)
      WITH n, pathways, tfDetails, collect(DISTINCT {id: g.id, name: g.name, domain: g.domain}) as gos
      OPTIONAL MATCH (n)-[:HAS_MAPMAN]->(m:MapMan)
      OPTIONAL MATCH path=(m)-[:SUBCATEGORY_OF*0..]->(root:MapMan)
      WHERE NOT (root)-[:SUBCATEGORY_OF]->()
      WITH n, pathways, tfDetails, gos,
           collect(DISTINCT [node in nodes(path) | {bincode: node.bincode, name: node.name}]) as mapmanPaths
      OPTIONAL MATCH (n)-[:HAS_UNIPROT]->(u:Uniprot)
      WITH n, pathways, tfDetails, gos, mapmanPaths,
           collect(DISTINCT {entry: u.entry, entry_name: u.entry_name, gene_names: u.gene_names, protein_names: u.protein_names, reviewed: u.reviewed}) as uniprotNodes
      OPTIONAL MATCH (n)-[:HAS_MOTIF]->(m:Motif)
      WITH n, pathways, tfDetails, gos, mapmanPaths, uniprotNodes,
           collect(DISTINCT {id: m.id, source: m.source}) as motifs
      OPTIONAL MATCH (n)-[:BELONGS_TO_CLUSTER]->(c:Cluster)
      WITH n, pathways, tfDetails, gos, mapmanPaths, uniprotNodes, motifs,
           collect(DISTINCT c.name) as clusters
      RETURN {
        id: n.id,
        symbol: n.symbol,
        msu_id: n.msu_id,
        identifier: n.identifier,
        deg: n.deg,
        type: n.type,
        full_name: n.full_name,
        description: n.full_name,
        kegg_gene: n.kegg_gene,
        keggDetail: [k in pathways WHERE k.code IS NOT NULL],
        pathways: [k in pathways WHERE k.code IS NOT NULL],
        tfDetail: [tf in tfDetails WHERE tf.id IS NOT NULL OR tf.family IS NOT NULL],
        tf_families: [tf in tfDetails WHERE tf.family IS NOT NULL | tf.family],
        attributes: { GO: [g in gos WHERE g.id IS NOT NULL] },
        ontologies: [g in gos WHERE g.id IS NOT NULL | { id: g.id, name: g.name }],
        mapmanPaths: mapmanPaths,
        uniprotDetail: [u in uniprotNodes WHERE u.entry IS NOT NULL],
        motifs: [m in motifs WHERE m.id IS NOT NULL],
        clusters: clusters
      } as metadata
      `,
      { nodeId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ error: "Gene not found." });
    }

    res.json(result.records[0].get("metadata"));
  } catch (error) {
    console.error("Node detail error:", error);
    res.status(500).json({ error: "Failed to retrieve node details." });
  } finally {
    await session.close();
  }
});

const NODE_METADATA_PROJECTION = `
      OPTIONAL MATCH (n)-[:IN_PATHWAY]->(p:Pathway)
      WITH reqId, n, collect(DISTINCT {code: p.id, name: p.name}) as pathways
      OPTIONAL MATCH (n)-[:BELONGS_TO_FAMILY]->(f:TFFamily)
      WITH reqId, n, pathways, collect(DISTINCT {id: n.tf_id, family: f.name}) as tfDetails
      OPTIONAL MATCH (n)-[:HAS_GO_TERM]->(g:GOTerm)
      WITH reqId, n, pathways, tfDetails, collect(DISTINCT {id: g.id, name: g.name, domain: g.domain}) as gos
      OPTIONAL MATCH (n)-[:HAS_MAPMAN]->(m:MapMan)
      OPTIONAL MATCH path=(m)-[:SUBCATEGORY_OF*0..]->(root:MapMan)
      WHERE NOT (root)-[:SUBCATEGORY_OF]->()
      WITH reqId, n, pathways, tfDetails, gos,
           collect(DISTINCT [node in nodes(path) | {bincode: node.bincode, name: node.name}]) as mapmanPaths
      OPTIONAL MATCH (n)-[:HAS_UNIPROT]->(u:Uniprot)
      WITH reqId, n, pathways, tfDetails, gos, mapmanPaths,
           collect(DISTINCT {entry: u.entry, entry_name: u.entry_name, gene_names: u.gene_names, protein_names: u.protein_names, reviewed: u.reviewed}) as uniprotNodes
      OPTIONAL MATCH (n)-[:HAS_MOTIF]->(m:Motif)
      WITH reqId, n, pathways, tfDetails, gos, mapmanPaths, uniprotNodes,
           collect(DISTINCT {id: m.id, source: m.source}) as motifs
      OPTIONAL MATCH (n)-[:BELONGS_TO_CLUSTER]->(c:Cluster)
      WITH reqId, n, pathways, tfDetails, gos, mapmanPaths, uniprotNodes, motifs,
           collect(DISTINCT c.name) as clusters
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
        keggDetail: [k in pathways WHERE k.code IS NOT NULL],
        pathways: [k in pathways WHERE k.code IS NOT NULL],
        tfDetail: [tf in tfDetails WHERE tf.id IS NOT NULL OR tf.family IS NOT NULL],
        tf_families: [tf in tfDetails WHERE tf.family IS NOT NULL | tf.family],
        attributes: { GO: [g in gos WHERE g.id IS NOT NULL] },
        ontologies: [g in gos WHERE g.id IS NOT NULL | { id: g.id, name: g.name }],
        mapmanPaths: mapmanPaths,
        uniprotDetail: [u in uniprotNodes WHERE u.entry IS NOT NULL],
        motifs: [m in motifs WHERE m.id IS NOT NULL],
        clusters: clusters
      } as metadata
`;

/**
 * POST /api/network/nodes/batch
 * Fetches comprehensive metadata and biological annotations for a batch of genes.
 * Uses indexed Gene.id lookup first, with fallback for MSU/symbol/identifier queries.
 */
app.post("/api/network/nodes/batch", async (req, res) => {
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Invalid gene IDs list provided." });
  }

  const uniqueValidIds = Array.from(
    new Set(
      ids
        .filter((id) => isValidIdentifier(id))
        .map((id) => String(id).trim())
    )
  ).slice(0, 2000);

  if (uniqueValidIds.length === 0) {
    return res.status(400).json({ error: "No valid gene identifiers provided." });
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const nodesById = {};

    // Fast path: indexed lookup by primary Gene.id (RAP-DB ID)
    const primaryResult = await session.run(
      `
      UNWIND $ids AS reqId
      MATCH (n:Gene {id: reqId})
      ${NODE_METADATA_PROJECTION}
      `,
      { ids: uniqueValidIds }
    );

    primaryResult.records.forEach((r) => {
      const reqId = r.get("reqId");
      const meta = r.get("metadata");
      if (meta && meta.deg && typeof meta.deg.toNumber === "function") {
        meta.deg = meta.deg.toNumber();
      }
      nodesById[reqId] = meta;
    });

    // Fallback path for any IDs not matched by Gene.id (e.g., MSU IDs, symbols, identifiers)
    const missingIds = uniqueValidIds.filter((id) => !nodesById[id]);
    if (missingIds.length > 0) {
      const fallbackResult = await session.run(
        `
        UNWIND $ids AS reqId
        MATCH (n:Gene)
        WHERE n.msu_id = reqId OR n.symbol = reqId OR n.identifier = reqId
        WITH reqId, head(collect(n)) AS n
        WHERE n IS NOT NULL
        ${NODE_METADATA_PROJECTION}
        `,
        { ids: missingIds }
      );

      fallbackResult.records.forEach((r) => {
        const reqId = r.get("reqId");
        const meta = r.get("metadata");
        if (meta && meta.deg && typeof meta.deg.toNumber === "function") {
          meta.deg = meta.deg.toNumber();
        }
        nodesById[reqId] = meta;
      });
    }

    res.json({ nodesById });
  } catch (error) {
    console.error("Batch node detail error:", error);
    res.status(500).json({ error: "Failed to retrieve batch node details." });
  } finally {
    await session.close();
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Protected API Middleware running on port ${PORT}.`);
});
