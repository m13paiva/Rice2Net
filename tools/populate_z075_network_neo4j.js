/**
 * populate_z075_network_neo4j.js
 *
 * Updates Neo4j with the precomputed z >= 0.75 global network layout:
 *  1. Resets x, y, deg on all :Gene nodes and writes new (x, y, deg) from network_z075_nodes.tsv
 *  2. Removes old :INTERACTS_WITH relationships in safe batched transactions
 *  3. Streams network_z075_edges.tsv (2,972,148 edges) into :INTERACTS_WITH {weight, z_score, sign}
 *  4. Verifies exact node, edge, Z-score, and non-INTERACTS_WITH relationship counts
 *
 * Usage:
 *   node tools/populate_z075_network_neo4j.js [nodes_tsv] [edges_tsv]
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const neo4j = require(path.join(__dirname, "../server/node_modules/neo4j-driver"));

const NODES_TSV =
  process.argv[2] ||
  path.join(__dirname, "../layout_out/network_z075_nodes.tsv");
const EDGES_TSV =
  process.argv[3] ||
  path.join(__dirname, "../layout_out/network_z075_edges.tsv");

const NEO4J_URI = process.env.NEO4J_URI || "bolt://127.0.0.1:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "neo4j123";

const NODE_BATCH_SIZE = 5000;
const DELETE_BATCH_SIZE = 50000;
const EDGE_BATCH_SIZE = 25000;

async function main() {
  const t0 = Date.now();
  if (!fs.existsSync(NODES_TSV)) throw new Error(`Missing nodes TSV: ${NODES_TSV}`);
  if (!fs.existsSync(EDGES_TSV)) throw new Error(`Missing edges TSV: ${EDGES_TSV}`);

  const driver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    { maxConnectionPoolSize: 20 }
  );

  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

  try {
    // 1. Update Gene node coordinates & degrees
    console.log(`[1/4] Updating Gene coordinates from ${NODES_TSV}...`);
    const nodeLines = fs
      .readFileSync(NODES_TSV, "utf8")
      .trim()
      .split(/\r?\n/)
      .slice(1);

    const nodeRows = nodeLines.map((line) => {
      const [id, x, y, deg] = line.split("\t");
      return {
        id,
        x: Number(x),
        y: Number(y),
        deg: neo4j.int(parseInt(deg, 10)),
      };
    });

    // Reset existing x, y, deg on all Gene nodes first so unconnected genes stay clean (null coords)
    await session.run(`
      MATCH (g:Gene)
      SET g.x = null, g.y = null, g.deg = 0
    `);

    let updatedNodes = 0;
    for (let i = 0; i < nodeRows.length; i += NODE_BATCH_SIZE) {
      const batch = nodeRows.slice(i, i + NODE_BATCH_SIZE);
      const res = await session.run(
        `
        UNWIND $rows AS row
        MATCH (g:Gene {id: row.id})
        SET g.x = row.x, g.y = row.y, g.deg = row.deg
        RETURN count(g) AS c
        `,
        { rows: batch }
      );
      updatedNodes += res.records[0].get("c").toNumber();
    }
    console.log(`      Updated ${updatedNodes.toLocaleString()} / ${nodeRows.length.toLocaleString()} Gene nodes.`);

    // 2. Delete existing INTERACTS_WITH edges in safe batches
    console.log(`[2/4] Deleting existing INTERACTS_WITH edges in batches of ${DELETE_BATCH_SIZE.toLocaleString()}...`);
    let totalDeleted = 0;
    while (true) {
      const res = await session.run(
        `
        MATCH ()-[r:INTERACTS_WITH]->()
        WITH r LIMIT $lim
        DELETE r
        RETURN count(*) AS c
        `,
        { lim: neo4j.int(DELETE_BATCH_SIZE) }
      );
      const deleted = res.records[0].get("c").toNumber();
      totalDeleted += deleted;
      if (deleted < DELETE_BATCH_SIZE) break;
      if (totalDeleted % 200000 === 0) {
        console.log(`      Deleted ${totalDeleted.toLocaleString()} edges...`);
      }
    }
    console.log(`      Deleted ${totalDeleted.toLocaleString()} old INTERACTS_WITH edges.`);

    // 3. Stream & insert new INTERACTS_WITH edges
    console.log(`[3/4] Inserting new INTERACTS_WITH edges from ${EDGES_TSV} (batch=${EDGE_BATCH_SIZE.toLocaleString()})...`);
    const rl = readline.createInterface({
      input: fs.createReadStream(EDGES_TSV, { encoding: "utf8", highWaterMark: 1 << 20 }),
      crlfDelay: Infinity,
    });

    let batch = [];
    let totalInserted = 0;
    let isHeader = true;
    const tInsertStart = Date.now();

    const flushBatch = async (rows) => {
      if (rows.length === 0) return;
      const res = await session.run(
        `
        UNWIND $rows AS row
        MATCH (s:Gene {id: row.s}), (t:Gene {id: row.t})
        CREATE (s)-[:INTERACTS_WITH {weight: row.w, z_score: row.z, sign: row.sign}]->(t)
        RETURN count(*) AS c
        `,
        { rows }
      );
      totalInserted += res.records[0].get("c").toNumber();
      if (totalInserted % 250000 < rows.length) {
        const elapsed = ((Date.now() - tInsertStart) / 1000).toFixed(1);
        const rate = Math.round(totalInserted / Math.max(0.1, (Date.now() - tInsertStart) / 1000));
        console.log(`      Inserted ${totalInserted.toLocaleString()} edges (${elapsed}s, ~${rate.toLocaleString()} edges/s)`);
      }
    };

    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const w = Number(parts[2]);
      const z = Number(parts[3]);
      const sign = parts[4] === "+" || parts[4] === "-" ? parts[4] : null;
      batch.push({ s: parts[0], t: parts[1], w, z, sign });
      if (batch.length >= EDGE_BATCH_SIZE) {
        await flushBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await flushBatch(batch);
      batch = [];
    }
    console.log(`      Finished inserting ${totalInserted.toLocaleString()} INTERACTS_WITH edges.`);

    // 4. Verify Neo4j state
    console.log("[4/4] Verifying Neo4j database integrity...");
    const verifyGenes = await session.run(`
      MATCH (g:Gene)
      RETURN count(g) AS total,
             count(g.x) AS withCoords,
             sum(CASE WHEN g.x IS NULL THEN 1 ELSE 0 END) AS withoutCoords,
             min(g.x) AS minX, max(g.x) AS maxX,
             min(g.y) AS minY, max(g.y) AS maxY
    `);
    const gRec = verifyGenes.records[0];
    console.log("      Genes:", {
      total: gRec.get("total").toNumber(),
      withCoords: gRec.get("withCoords").toNumber(),
      withoutCoords: gRec.get("withoutCoords").toNumber(),
      xRange: [gRec.get("minX"), gRec.get("maxX")],
      yRange: [gRec.get("minY"), gRec.get("maxY")],
    });

    const verifyEdges = await session.run(`
      MATCH ()-[r:INTERACTS_WITH]->()
      RETURN count(r) AS total,
             count(r.z_score) AS withZ,
             count(r.irp) AS withIrp,
             min(r.z_score) AS minZ,
             max(r.z_score) AS maxZ,
             sum(CASE WHEN r.z_score >= 1.28 THEN 1 ELSE 0 END) AS ge128
    `);
    const eRec = verifyEdges.records[0];
    console.log("      INTERACTS_WITH:", {
      total: eRec.get("total").toNumber(),
      withZ: eRec.get("withZ").toNumber(),
      withIrp: eRec.get("withIrp").toNumber(),
      zRange: [eRec.get("minZ"), eRec.get("maxZ")],
      ge128: eRec.get("ge128").toNumber(),
    });

    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Migration complete in ${totalSec}s!`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
