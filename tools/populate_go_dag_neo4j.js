#!/usr/bin/env node
/**
 * populate_go_dag_neo4j.js
 *
 * One-time (idempotent) database migration script that enriches Rice2Net's Neo4j
 * database with the Gene Ontology DAG hierarchy (`IS_A` and `PART_OF` edges)
 * for all GO terms present in the DB and their transitive ancestors, and backfills
 * missing `name` / `domain` properties on existing `GOTerm` nodes.
 *
 * After running this script, Neo4j is completely self-contained for GO DAG
 * true-path propagation during ORA enrichment (no external OBO/JSON files needed).
 */

const path = require("path");
const { createRequire } = require("module");

const serverDir = path.resolve(__dirname, "..", "server");
const serverRequire = createRequire(path.join(serverDir, "package.json"));
serverRequire("dotenv").config({ path: path.join(serverDir, ".env") });
const neo4j = serverRequire("neo4j-driver");

const OBO_URL = "https://current.geneontology.org/ontology/go-basic.obo";

function parseObo(text) {
  const terms = new Map();
  const altIds = new Map();

  const blocks = text.split(/\n\[Term\]\n/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split(/\n\[(?:Typedef|Instance)\]/)[0];
    const lines = block.split(/\r?\n/);

    let id = null;
    let name = "";
    let namespace = "";
    let isObsolete = false;
    const isA = [];
    const partOf = [];
    const alts = [];

    for (const line of lines) {
      if (line.startsWith("id: ")) {
        id = line.slice(4).trim();
      } else if (line.startsWith("name: ")) {
        name = line.slice(6).trim();
      } else if (line.startsWith("namespace: ")) {
        namespace = line.slice(11).trim();
      } else if (line.startsWith("alt_id: ")) {
        alts.push(line.slice(8).trim());
      } else if (line.startsWith("is_obsolete: true")) {
        isObsolete = true;
      } else if (line.startsWith("is_a: ")) {
        const parentId = line.slice(6).split("!")[0].trim();
        if (parentId.startsWith("GO:")) isA.push(parentId);
      } else if (line.startsWith("relationship: part_of ")) {
        const parentId = line.slice(22).split("!")[0].trim();
        if (parentId.startsWith("GO:")) partOf.push(parentId);
      }
    }

    if (!id || !id.startsWith("GO:") || isObsolete) continue;

    terms.set(id, {
      id,
      name,
      domain: namespace, // biological_process | molecular_function | cellular_component
      isA,
      partOf,
    });

    for (const alt of alts) {
      if (alt.startsWith("GO:")) altIds.set(alt, id);
    }
  }

  return { terms, altIds };
}

async function main() {
  console.log(`Fetching ${OBO_URL} ...`);
  const resp = await fetch(OBO_URL, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`Failed to fetch go-basic.obo: HTTP ${resp.status}`);
  }
  const oboText = await resp.text();
  console.log(`Downloaded ${(oboText.length / 1e6).toFixed(2)} MB.`);

  const { terms, altIds } = parseObo(oboText);
  console.log(`Parsed ${terms.size} active GO terms and ${altIds.size} alt_ids.`);

  const driver = neo4j.driver(
    process.env.NEO4J_URI || "bolt://127.0.0.1:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER || "neo4j",
      process.env.NEO4J_PASSWORD || "neo4j123"
    )
  );

  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

  try {
    // 1. Read all existing GOTerm IDs from Neo4j
    const existingRes = await session.run(
      "MATCH (g:GOTerm) RETURN g.id AS id"
    );
    const dbGoIds = existingRes.records
      .map((r) => r.get("id"))
      .filter((id) => typeof id === "string" && id.startsWith("GO:"));
    console.log(`Found ${dbGoIds.length} existing GOTerm nodes in Neo4j.`);

    // 2. Collect all reachable ancestor GO terms + direct IS_A / PART_OF edges
    const neededTerms = new Map(); // id -> { id, name, domain }
    const isAEdges = new Map(); // "child|parent" -> { child, parent }
    const partOfEdges = new Map(); // "child|parent" -> { child, parent }

    // Track alt_id links so existing DB alt_id nodes also connect cleanly to canonical DAG
    const queue = [];
    const visited = new Set();

    for (const rawId of dbGoIds) {
      let canonical = rawId;
      if (!terms.has(canonical) && altIds.has(canonical)) {
        canonical = altIds.get(canonical);
        const entry = terms.get(canonical);
        if (entry) {
          neededTerms.set(rawId, {
            id: rawId,
            name: entry.name,
            domain: entry.domain,
          });
          isAEdges.set(`${rawId}|${canonical}`, {
            child: rawId,
            parent: canonical,
          });
        }
      }
      if (terms.has(canonical) && !visited.has(canonical)) {
        visited.add(canonical);
        queue.push(canonical);
      }
    }

    while (queue.length > 0) {
      const currId = queue.pop();
      const entry = terms.get(currId);
      if (!entry) continue;

      neededTerms.set(currId, {
        id: currId,
        name: entry.name,
        domain: entry.domain,
      });

      for (const pId of entry.isA) {
        if (!terms.has(pId)) continue;
        isAEdges.set(`${currId}|${pId}`, { child: currId, parent: pId });
        if (!visited.has(pId)) {
          visited.add(pId);
          queue.push(pId);
        }
      }

      for (const pId of entry.partOf) {
        if (!terms.has(pId)) continue;
        partOfEdges.set(`${currId}|${pId}`, { child: currId, parent: pId });
        if (!visited.has(pId)) {
          visited.add(pId);
          queue.push(pId);
        }
      }
    }

    const termRows = Array.from(neededTerms.values());
    const isARows = Array.from(isAEdges.values());
    const partOfRows = Array.from(partOfEdges.values());

    console.log(
      `Prepared ${termRows.length} GOTerm nodes, ${isARows.length} IS_A edges, and ${partOfRows.length} PART_OF edges.`
    );

    // 3. Batch MERGE GOTerm nodes (creating missing ancestors & backfilling empty name/domain)
    const BATCH = 1000;
    for (let i = 0; i < termRows.length; i += BATCH) {
      const chunk = termRows.slice(i, i + BATCH);
      await session.run(
        `
        UNWIND $rows AS row
        MERGE (t:GOTerm {id: row.id})
        ON CREATE SET t.name = row.name, t.domain = row.domain
        SET t.name = CASE WHEN t.name IS NULL OR trim(t.name) = '' THEN row.name ELSE t.name END,
            t.domain = CASE WHEN t.domain IS NULL OR trim(t.domain) = '' THEN row.domain ELSE t.domain END
        `,
        { rows: chunk }
      );
    }

    // 4. Batch MERGE IS_A relationships
    for (let i = 0; i < isARows.length; i += BATCH) {
      const chunk = isARows.slice(i, i + BATCH);
      await session.run(
        `
        UNWIND $rows AS row
        MATCH (c:GOTerm {id: row.child}), (p:GOTerm {id: row.parent})
        MERGE (c)-[:IS_A]->(p)
        `,
        { rows: chunk }
      );
    }

    // 5. Batch MERGE PART_OF relationships
    for (let i = 0; i < partOfRows.length; i += BATCH) {
      const chunk = partOfRows.slice(i, i + BATCH);
      await session.run(
        `
        UNWIND $rows AS row
        MATCH (c:GOTerm {id: row.child}), (p:GOTerm {id: row.parent})
        MERGE (c)-[:PART_OF]->(p)
        `,
        { rows: chunk }
      );
    }

    // 6. Verify resulting Neo4j counts
    const verifyRes = await session.run(`
      MATCH (t:GOTerm)
      WITH count(t) AS totalTerms,
           count(CASE WHEN t.domain IS NULL OR t.domain = '' THEN 1 END) AS emptyDomain,
           count(CASE WHEN t.name IS NULL OR t.name = '' THEN 1 END) AS emptyName
      OPTIONAL MATCH (:GOTerm)-[r1:IS_A]->(:GOTerm)
      WITH totalTerms, emptyDomain, emptyName, count(r1) AS isACount
      OPTIONAL MATCH (:GOTerm)-[r2:PART_OF]->(:GOTerm)
      RETURN totalTerms, emptyDomain, emptyName, isACount, count(r2) AS partOfCount
    `);
    const summary = verifyRes.records[0].toObject();
    console.log("Neo4j GO DAG migration complete:", {
      totalTerms: summary.totalTerms.toNumber(),
      emptyDomain: summary.emptyDomain.toNumber(),
      emptyName: summary.emptyName.toNumber(),
      isACount: summary.isACount.toNumber(),
      partOfCount: summary.partOfCount.toNumber(),
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("GO DAG Neo4j migration failed:", err);
  process.exit(1);
});
