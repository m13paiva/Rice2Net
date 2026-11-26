# Changelog

All notable changes to Rice2Net are listed here.

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
