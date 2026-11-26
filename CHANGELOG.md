# Changelog

All notable changes to Rice2Net are listed here.

---

## [2.0.0]

### Added
- **In-App Community Discovery & ORA (`Analyze → Community Discovery`):**
  - Integrated official WebAssembly **Infomap** (`@mapequation/infomap`) and exact upper-tail Hypergeometric **ORA (Over-Representation Analysis)** with per-source Benjamini–Hochberg FDR (`@stdlib/stats`) directly in the Node.js backend (`server/community_discovery.js`) and frontend (`app/analyze.js`).
  - Runs strictly on the currently visible nodes and edges with configurable **Markov Time** (default `1`), **Background Gene Set** (*All genes in visible network*, *No background*, or *Custom list* via text input or file upload), **Background Gene Scope** (*Only annotated* vs. *All genes*), and **Adjusted p-value Threshold** (default `0.05`).
  - Filters results to display only clusters with significantly enriched ORA terms across `GO:BP`, `GO:MF`, `GO:CC`, `MapMan` (excluding bin `35: not assigned`), and `KEGG`.
- **Interactive Cluster Management & ORA Report:**
  - Users can rename (inline in the legend or report), recolor (live color picker preserving custom colors across theme changes), toggle visibility, inspect, and delete individual clusters.
  - Added an interactive **ORA Report** modal featuring source filter chips, 3-level multi-parameter sorting (*Order by → Then → Then* plus clickable column headers), horizontal **Fold** bar plots on a shared 0-to-max axis (light-green to dark-red color scale), clickable overlapping gene lists, and TSV exports for ORA tables and cluster gene lists.
- **Promoter-Binding Motifs Submenu (`Analyze → Promoter-Binding Motifs`):**
  - Added a dedicated motif search panel allowing users to select supporting motif databases (**PlantTFDB**, **JASPAR Core**, **JASPAR Unvalidated**, and **CIS-BP**).
  - Updated `POST /api/network/edges/regulates` and `GET/POST /api/network/edges/binds` to filter by the four boolean source flags on `REGULATES` relationships and matching `Motif.source` entries.
  - Regulation edges now appear in the Edge Legend (in the show state) only after running a search; toggling them hides/shows current edges without re-querying the database, and re-running clears all prior regulation edges first.
- **GO DAG Hierarchy & Precomputed Global Clusters in Neo4j:**
  - Added `tools/populate_go_dag_neo4j.js` to store `9,586` `IS_A` and `823` `PART_OF` edges across `6,614` `GOTerm` nodes directly in Neo4j (backfilling `name`/`domain` on 595 previously incomplete terms) for self-contained true-path GO DAG propagation.
  - Added `tools/populate_global_clusters_neo4j.js` to populate 8 curated global network clusters (`21,075` `BELONGS_TO_CLUSTER` edges and `1,776` precomputed `ENRICHED_IN` ORA edges) for instant startup (`164,770` total nodes and `23,245,227` total edges).
- **New Backend Endpoints (`server/server.js`):**
  - Added `POST /api/analyze/community-discovery` (with a 64 MB JSON body limit for large networks), `POST /api/analyze/ora` (ORA-only re-analysis for imported clusters), and `POST /api/analyze/term-genes` (on-demand overlap gene resolution for DB-stored clusters).
- **Cluster Round-Trip Export & Import:**
  - Added cluster metadata (gene memberships, names, colors, and adjusted p-value threshold) to Layout JSON, Edges TSV (`#RICE2NET_*` header lines + `Source_Cluster`/`Target_Cluster` columns), and Genes TSV exports (`app/exporters.js`).
  - Importing JSON or TSV files containing cluster metadata now automatically restores the clusters and runs ORA-only re-analysis (`app/core.js`, `app/analyze.js`).

### Changed
- **Standardized UI Terminology & Messages:**
  - Standardized user-facing labels to use **ORA** instead of *Enrichment*, removed the redundant header `ORA` button on the Cluster legend, and simplified `"Markov Time (Infomap)"` to `"Markov Time"`.
  - Updated loader and status messages across the app for clarity and consistency (e.g., `"Fetching network topology"`, `"Fetching promoter-binding motif occurrences"`, `"Generating high-resolution image"`, `"Loading gene annotations"`).
- **Re-enabled Global Clusters by Default:**
  - Re-enabled `CLUSTERS_ENABLED` with stable ID-based `CLUSTER_STATE` tracking across rendering, details, legends, and PNG/tabular exports, and ensured reverting from imported networks always resets in-memory clusters and regulation overlays cleanly before reloading DB clusters.
- **Updated Documentation:**
  - Updated `README.md` and `homepage.html` with the new `Analyze` workflows, global cluster summary, and current Neo4j database statistics.

### Fixed
- **Sidebar Textarea Overflow (`style.css`):**
  - Added `box-sizing: border-box` to sidebar inputs and textareas so both the Target Genes box and Custom Background box stay cleanly aligned inside their containers.
- **Server Restart Cleanup (`start_app.sh`):**
  - Fixed `pkill` pattern (`node.*server\.js`) so re-running `start_app.sh` properly stops older `node --max-old-space-size=8192 server.js` instances instead of leaving stale backend processes bound to port `3000`.

---

## [1.1.0]

### Added
- **Static Web Demo (`demo_data/`):**
  - Added a static web demo built from a thiamine biosynthesis subnetwork (679 genes, 12,031 edges, 346 regulatory edges / 350 directed pairs, 668 TF-promoter motif binding events, and full gene annotations), stored as static JSON files (2.26 MB total) so the app can run on GitHub Pages without a backend server.
  - Added a script (`tools/export_demo_bundle.js`) to generate `demo_data/` from Neo4j, plus a `.nojekyll` file for GitHub Pages.
  - Added a small `Web Demo` label at the top of the screen and a short notice when importing custom files in demo mode.
- **Data Adapter (`app/api.js`):**
  - Moved all backend requests into a single `window.RICE2NET_API` file.
  - Automatically switches to static demo mode when hosted on `*.github.io` or when `?demo=1` is in the URL, while keeping normal HTTP server mode everywhere else.
- **Drag-and-Drop File Import:**
  - Users can now drag and drop `.json` layout files and `.tsv`, `.csv`, or `.txt` edge files directly onto the canvas to load them.
- **Edge `Sign` Attribute (`+` / `-`):**
  - Added support for positive (`+`) and negative (`-`) edge signs when loading from Neo4j, importing or exporting TSV/JSON files, hovering edges, viewing edge details, and viewing the connections list in node details.
- **Batched Server Endpoints (`server/server.js`):**
  - Added `POST /api/network/nodes/batch` to fetch metadata for many genes in one request (looking up by RAP ID first, then falling back to MSU ID, symbol, or identifier).
  - Added `POST /api/network/edges/binds` to fetch motif binding data for multiple edges in one request.
- **Local D3 Copy:**
  - Bundled D3.js v7.9.2 locally in `vendor/d3.v7.min.js` instead of loading it from a CDN.

### Changed
- **Updated Global Network in Neo4j:**
  - Replaced the old coexpression edges and node positions in Neo4j with the new global network (21,167 connected genes and 824,461 signed `INTERACTS_WITH` edges: 788,173 `+` and 36,288 `-`; 162,736 total nodes and 23,211,967 total edges).
- **Updated Documentation and Plots:**
  - Updated `README.md`, `homepage.html`, `homepage_styles.css`, and the evaluation plots (`figures/violin_half.png`, `figures/sat_auroc.png`) with the new network evaluation results (GO: 1,788 terms, Macro AUROC 0.6649, Macro AUPR 0.0171; MapMan: 780 bins, Macro AUROC 0.7094, Macro AUPR 0.0043) and updated database counts.
- **Disabled Functional Clusters:**
  - Turned off the functional cluster UI and requests using a `CLUSTERS_ENABLED = false` flag in `app/globals.js` so the code stays in place for when clusters are added back later.
  - Removed the 12 `Cluster` nodes and 11,259 `BELONGS_TO_CLUSTER` relationships from Neo4j, and added a note about this in `README.md` and `homepage.html`.
- **Faster Rendering and Lower Memory Use:**
  - Batched normal edge drawing into larger path chunks and skipped drawing edges and nodes that are outside the visible screen (`app/sim.js`).
  - Grouped nodes by style during rendering and removed per-node `ctx.save()` / `ctx.restore()` calls (`app/sim.js`).
  - Removed duplicate copies of the network stored at startup (`RAW_DATA.dbLinks` / cloned `RAW_DATA.dbNodes`) and cached the full adjacency list instead of rebuilding it on every filter, expand, or right-click (`app/data.js`, `app/filter.js`, `app/interactions.js`).
  - Replaced slow array searches (`nodes.find`) in `app/exporters.js`, `app/sim.js`, and `app/interactions.js` with `Map` lookups, and updated `Export Genes (.tsv)` to fetch gene metadata in batches instead of one request per gene.
  - Removed 6 unused duplicate functions from `app/core.js`.

### Fixed
- **IRP Score Filter:**
  - Fixed a bug where nodes and edges hidden by the IRP filter could still be hovered and clicked, by keeping only visible nodes in the quadtree and refreshing colors/visibility when the threshold changes.
  - Made the IRP slider wait 1 second after dragging stops on large networks so it no longer lags, while staying instant on small networks.
- **Large-Network Edge Hover and Click:**
  - Fixed hovering over an edge for 1 second on large networks so it highlights and opens edge details when clicked.
  - Fixed coordinate checks that treated `x === 0` or `y === 0` as missing coordinates.
- **Reverting Imported Networks:**
  - Clicking `✕` on an imported file now clears the canvas, shows a loading bar, and restores the database (or demo) network in place instead of reloading back to the homepage.
- **Target Explorer Search:**
  - Fixed gene search so it properly matches RAP-DB locus and transcript IDs, MSU IDs (with or without `LOC_`, isoform numbers, or multiple IDs), gene identifiers, and gene symbols (including symbols with semicolons like `HKT1;5` and optional `Os` prefixes).
- **Export and Import Fidelity:**
  - Fixed JSON and TSV export/import so gene labels keep using `identifier` instead of falling back to `symbol`, empty IRP scores stay empty instead of becoming `0`, weights of `0` are kept, `Directional` and `Sign` columns are handled properly, headered TSVs without a `Weight` column import cleanly, and regulation/motif lookups work on MSU-ID imported networks.
- **Neo4j Degree Numbers:**
  - Fixed Neo4j integer conversion for `n.deg` in `server/server.js` so degrees are returned as normal JSON numbers.
- **Dark Theme Consistency:**
  - Kept the sidebar and toolbar dark when Light Mode is turned on for the canvas.

---

## [1.0.0]

- Initial release of Rice2Net.
