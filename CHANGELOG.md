# Changelog

All notable changes to **Rice2Net** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased] — 2026-11-24 to 2026-11-25

### Added
- **Zero-Backend Static Web Demo (`demo_data/`):**
  - Exported a curated **Thiamine biosynthesis subnetwork** (`679` genes, `12,031` signed coexpression edges, `346` regulated edges / `350` directed pairs, `668` TF-promoter motif binding events, and full GO/MapMan/KEGG/UniProt/TF metadata) into compact static JSON files (`2.26 MB` total) at the repository root alongside `.nojekyll` for GitHub Pages.
  - Added reproducible export script [`tools/export_demo_bundle.js`](tools/export_demo_bundle.js) to build `demo_data/` directly from Neo4j.
  - Added non-intrusive `Web Demo` badge and custom import notice in Static Demo Mode.
- **Unified Web Data Adapter (`app/api.js`):**
  - Centralized all network, cluster, node metadata, regulation, and motif binding requests behind `window.RICE2NET_API`.
  - Added automatic environment detection switching to Static Demo Mode on `*.github.io` or `?demo=1` while preserving HTTP Mode for local dev and self-hosted Nginx deployments.
- **Drag-and-Drop Custom File Import:** Added canvas drag-and-drop support for `.json` layout files and `.tsv`/`.csv`/`.txt` edge tables with visual drop overlay.
- **Edge `Sign` Attribute Support (`+` / `-`):** Added full support across Neo4j ingestion, hover tooltips, Edge Details panel, Node Details `CONNECTIONS` table, TSV/JSON exports, and headered/headerless edge imports.
- **Batched Backend Endpoints (`server/server.js`):**
  - Added `POST /api/network/nodes/batch` using indexed `Gene.id` lookup with fallback for MSU IDs, symbols, and identifiers.
  - Added `POST /api/network/edges/binds` for batched TF-promoter motif binding queries.
- **Offline Frontend Dependency:** Bundled D3.js v7.9.2 locally at `vendor/d3.v7.min.js`.

### Changed
- **Updated Embedded Global Coexpression Network (Neo4j):**
  - Replaced `INTERACTS_WITH` edges and `:Gene` spatial coordinates (`x`, `y`, `deg`) from the refreshed global network (`21,167` connected genes, `824,461` signed edges: `788,173` `+` and `36,288` `-`; `162,736` total nodes and `23,211,967` total relationships).
- **Updated Documentation & Performance Figures:**
  - Updated `README.md`, `homepage.html`, `homepage_styles.css`, and plots (`figures/violin_half.png`, `figures/sat_auroc.png`) with refreshed global benchmarks (GO: `1,788` terms, Macro AUROC `0.6649`, Macro AUPR `0.0171`; MapMan: `780` bins, Macro AUROC `0.7094`, Macro AUPR `0.0043`), live database statistics, and a prominent GitHub Pages Web Demo badge.
- **Silently Disabled Functionally Enriched Clusters:**
  - Gated all frontend cluster UI, API calls, overlays, and export legend items behind `CLUSTERS_ENABLED = false` in `app/globals.js` so the underlying architecture stays intact for future reimplementation.
  - Removed the `12` `:Cluster` nodes and `11,259` `:BELONGS_TO_CLUSTER` relationships from Neo4j, and documented the removal and reimplementation plan in `README.md` and `homepage.html`.
- **Canvas, Memory & Interaction Performance Optimizations:**
  - Batched normal undirected edge rendering (`app/sim.js`) in 15k-edge path chunks with world-space viewport culling.
  - Optimized node rendering (`app/sim.js`) with viewport culling, style-bucketed batching, and zero per-node `ctx.save()`/`ctx.restore()` calls.
  - Eliminated startup RAM bloat in `app/data.js` by removing redundant `RAW_DATA.dbLinks`/`RAW_DATA.dbNodes` clones and caching `fullAdjacency` across `runFilter`, `expandNode`, `fetchRegulationEdges`, and right-click context menu checks.
  - Replaced `O(E × N)` `nodes.find()` scans in `app/exporters.js`, `app/sim.js`, and `app/interactions.js` with `Map` lookups, and switched `exportGenesTSV()` from N+1 individual GET requests to batched metadata lookups.
  - Removed 6 dead shadowed duplicate functions from `app/core.js`.

### Fixed
- **IRP Score Filter Clickability & Lag:** Rebuilt the spatial quadtree (`rebuildInteractiveQuadtree()`) to include only currently visible/interactive nodes so IRP-filtered and legend-hidden nodes/edges cannot be hovered or clicked; synced visibility on threshold raise/lower via `reapplyColors()`; added a 1-second slider debounce on large networks (`> 5,000` nodes or `> 40,000` edges) while keeping small networks instant.
- **Large-Network Edge Hover & Click:** Fixed edge hit-testing after the 1-second hover dwell on large networks (including long edges with off-screen endpoints) and fixed falsy coordinate checks (`x === 0`) across `app/sim.js`, `app/interactions.js`, and `app/exporters.js`.
- **In-Memory Network Revert:** Clicking `✕` on an imported file now clears the canvas, locks interaction with staged loader feedback, and restores the embedded/demo network in memory without reloading back to the homepage overlay.
- **Target Explorer Search:** Fixed target resolution across RAP-DB locus and transcript IDs, MSU IDs (with/without `LOC_` prefix, isoforms, or multi-MSU fields), gene identifiers, and gene symbols (including semicolon symbols such as `HKT1;5` and optional `Os` prefixes).
- **JSON & TSV Export/Import Fidelity:** Preserved `identifier`-first node labels, `null` IRP scores, explicit `0` weights, `Directional` and `Sign` edge export columns, headered TSV imports lacking a `Weight` column, and `rap_id` resolution for on-demand regulation/motif queries on MSU-ID imported networks.
- **Backend Integer Serialization:** Converted Neo4j `Integer` `n.deg` values to plain JSON numbers in `/api/network/init` and `/api/network/node/:id`.
- **Theme Consistency:** Locked sidebar and toolbar to dark styling when Light Mode is enabled for the canvas.

---

## [1.0.0] — 2026-09-10 to 2026-09-11

### Added
- **Initial Release of Rice2Net:**
  - Interactive HTML5 Canvas + D3.js force-directed network explorer for *Oryza sativa* coexpression and TF-gene regulatory networks.
  - **Target Explorer:** Subnetwork extraction by search depth, Connect Neighbors toggle, Prune Dead Ends (leaf pruning), and right-click graph manipulation (`Expand`, `Contract`, `Pop`).
  - **Layout & Visual Controls:** Pan/Select/Auto-Fit toolbar, Light/Dark theme toggle, node/edge sizing and opacity sliders, physics tuning, and layout recalculation.
  - **Biological Annotations & Causality:** Node Detail panels (RAP-DB/MSU IDs, Gene Ontology with QuickGO links, MapMan hierarchy trees, KEGG pathways with inline map preview, UniProt entries, PlantTFDB/iTAK TF families) and on-demand `REGULATES` directional arrows with `HAS_MOTIF`/`BINDS` TF-promoter binding tables.
  - **Export & Import Suite:** High-resolution PNG export (with legend and "Show all edges"), Edges `.tsv`, Layout `.json`, Genes `.tsv` (with RAP/MSU ID format toggle), plus JSON layout and TSV/CSV edge list importers.
  - **Backend & Deployment Stack:** Node.js Express + Neo4j API middleware (`server/server.js`) with Helmet, CORS, and rate limiting, Nginx reverse-proxy configuration (`deploy/rice2net.conf`), deployment documentation (`README_DEPLOYMENT.md`), homepage (`homepage.html`), and Rice2Net logo/architecture visuals.
