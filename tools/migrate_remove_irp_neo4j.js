#!/usr/bin/env node
/**
 * migrate_remove_irp_neo4j.js
 *
 * Removes the redundant `irp` property (identical to `weight`) from all
 * `INTERACTS_WITH` relationships in Neo4j in safe transaction batches,
 * preparing edges for the `z_score` property.
 */

const path = require("path");
const { createRequire } = require("module");

const serverDir = path.resolve(__dirname, "..", "server");
const serverRequire = createRequire(path.join(serverDir, "package.json"));
serverRequire("dotenv").config({ path: path.join(serverDir, ".env") });
const neo4j = serverRequire("neo4j-driver");

async function main() {
  const driver = neo4j.driver(
    process.env.NEO4J_URI || "bolt://127.0.0.1:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER || "neo4j",
      process.env.NEO4J_PASSWORD || "neo4j123"
    )
  );

  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    let totalRemoved = 0;
    const BATCH_SIZE = 50000;

    while (true) {
      const res = await session.run(
        `
        MATCH ()-[r:INTERACTS_WITH]->()
        WHERE r.irp IS NOT NULL
        WITH r LIMIT $limit
        REMOVE r.irp
        RETURN count(r) AS removed
        `,
        { limit: neo4j.int(BATCH_SIZE) }
      );
      const removed = res.records[0].get("removed").toNumber();
      if (removed === 0) break;
      totalRemoved += removed;
      console.log(`  Removed r.irp from ${totalRemoved.toLocaleString()} INTERACTS_WITH edges...`);
    }

    const check = await session.run(`
      MATCH ()-[r:INTERACTS_WITH]->()
      RETURN count(r) AS total, count(r.irp) AS remainingIrp, count(r.weight) AS hasWeight, count(r.z_score) AS hasZScore
    `);
    const stats = check.records[0].toObject();
    console.log("Migration complete:", {
      total: stats.total.toNumber(),
      remainingIrp: stats.remainingIrp.toNumber(),
      hasWeight: stats.hasWeight.toNumber(),
      hasZScore: stats.hasZScore.toNumber(),
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("Failed to remove r.irp from Neo4j:", err);
  process.exit(1);
});
