/**
 * core.js - Secondary Network Bootstrapper & Import Module
 * 
 * Handles custom network graph imports (JSON, edge list TSVs), local subnetwork physics,
 * and fallback rendering helper definitions.
 */

/**
 * Imports a custom network layout structure from a user-uploaded JSON file.
 * @param {HTMLInputElement} input - File input element.
 */
window.importJSON = function (input) {
  if (!input.files || !input.files[0]) return;
  const fileName = input.files[0].name;

  const loader = document.getElementById("loader");
  const progressBar = document.getElementById("progress-bar");

  loader.style.display = "block";
  document.getElementById("loader-text").innerText = "IMPORTING NETWORK LAYOUT... 0%";
  if (progressBar) progressBar.style.width = "0%";

  setTimeout(() => {
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const json = JSON.parse(e.target.result);
        if (!json.nodes || !json.edges)
          throw new Error("Invalid JSON structure");

        window.IS_IMPORTED_NETWORK = true;
        if (typeof window.resetClustersState === "function") {
          window.resetClustersState();
        }
        window.CLUSTERS_ENABLED = false;
        if (typeof window.clearPromoterMotifAnalysis === "function") {
          window.clearPromoterMotifAnalysis(true);
        } else {
          VISIBILITY_STATE.EdgeBoth = 0;
        }
        if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();

        const nameDisplay = document.getElementById('import-json-name');
        const infoDisplay = document.getElementById('import-json-info');
        if (nameDisplay && infoDisplay) {
            nameDisplay.innerText = fileName;
            infoDisplay.style.display = 'flex';
        }
        const edgesInfo = document.getElementById('import-edges-info');
        if (edgesInfo) edgesInfo.style.display = 'none';

        RAW_DATA.nodes = json.nodes;
        RAW_DATA.links = json.edges;

        nodes = json.nodes.map((n) => {
          const nodeObj = {
            ...n,
            identifier: n.identifier || (n.metadata && (n.metadata.Identifier || n.metadata.identifier)) || "",
            symbol: n.symbol || (n.metadata && (n.metadata.Symbol || n.metadata.symbol)) || "",
            msu_id: n.msu_id || (n.metadata && (n.metadata.MSU_ID || n.metadata.msu_id)) || "",
            originalType: n.originalType || n.type || "Gene",
            deg: n.deg !== undefined && n.deg !== null ? n.deg : 0,
            _hasLayoutPos: n.x !== null && n.x !== undefined && n.y !== null && n.y !== undefined,
          };
          if (typeof window.applyNodeTypeStyling === "function") {
            window.applyNodeTypeStyling(nodeObj);
          }
          return nodeObj;
        });
        const nodeMap = new Map();
        nodes.forEach((n) => {
          nodeMap.set(String(n.id), n);
          if (n.rap_id) nodeMap.set(String(n.rap_id), n);
          if (n.msu_id) {
            nodeMap.set(String(n.msu_id), n);
            nodeMap.set(String(n.msu_id).replace(/\.\d+$/, ""), n);
          }
        });

        document.getElementById("loader-text").innerText = "IMPORTING NETWORK LAYOUT... 50%";
        if (progressBar) progressBar.style.width = "50%";

        links = json.edges
          .map((e) => {
            const sId = String(e.source?.id || e.source);
            const tId = String(e.target?.id || e.target);
            const sNode = nodeMap.get(sId);
            const tNode = nodeMap.get(tId);
            if (!sNode || !tNode) return null;

            const rawZ = e.z_score !== undefined && e.z_score !== null
              ? e.z_score
              : e.zscore !== undefined && e.zscore !== null
              ? e.zscore
              : e.Z_Score !== undefined && e.Z_Score !== null
              ? e.Z_Score
              : null;
            const parsedZ = rawZ !== null && rawZ !== "" && Number.isFinite(Number(rawZ)) ? Number(rawZ) : null;

            return {
              source: sNode,
              target: tNode,
              weight:
                e.weight !== undefined && e.weight !== null
                  ? e.weight
                  : e.value !== undefined && e.value !== null
                  ? e.value
                  : 1,
              z_score: parsedZ,
              sign: e.sign || null,
              has_interacts: e.has_interacts !== false,
              has_regulates: false,
              directions: null,
              reg_matched: false,
            };
          })
          .filter(Boolean);

        await window.__APP_CORE__.hydrateMetadata();
        RAW_DATA.nodes = nodes;
        RAW_DATA.links = links;
        RAW_DATA.workingNodes = nodes;
        RAW_DATA.workingLinks = null;
        if (typeof window.__APP_CORE__.cacheMetaSnapshot === "function") {
          window.__APP_CORE__.cacheMetaSnapshot();
        }
        RAW_DATA.adjacency = window.__APP_CORE__.buildAdjacency(nodes, links);
        RAW_DATA.fullAdjacency = RAW_DATA.adjacency;
        RAW_DATA._fullAdjacencyLinksRef = RAW_DATA.links;

        const hasZScore =
          typeof window.configureZScoreBounds === "function"
            ? window.configureZScoreBounds(RAW_DATA.links)
            : false;
        if (hasZScore && typeof window.applyEdgeFilter === "function") {
          window.applyEdgeFilter();
        }

        if (loader) loader.style.display = "none";
        finishSetup(true);

        // Automatically restore saved clusters and run ORA-only re-analysis
        if (
          json.clusters &&
          Array.isArray(json.clusters.items) &&
          json.clusters.items.length > 0 &&
          typeof window.loadImportedClustersAndRunOra === "function"
        ) {
          await window.loadImportedClustersAndRunOra(json.clusters);
        }

        if (typeof window.showDemoImportNotice === "function") {
          window.showDemoImportNotice();
        }
      } catch (err) {
        alert("Error importing JSON: " + err.message);
        loader.style.display = "none";
      }
    };
    reader.readAsText(input.files[0]);
  }, 50);
};

/**
 * Imports custom edge links from a user-uploaded tabular TSV file.
 * @param {HTMLInputElement} input - File input element.
 */
window.importEdges = function (input) {
  if (!input.files || !input.files[0]) return;
  const fileName = input.files[0].name;

  const loader = document.getElementById("loader");
  const progressBar = document.getElementById("progress-bar");

  loader.style.display = "block";
  document.getElementById("loader-text").innerText = "IMPORTING EDGE TABLE... 0%";
  if (progressBar) progressBar.style.width = "0%";

  setTimeout(() => {
    const reader = new FileReader();
    reader.onload = async function (e) {
      document.getElementById("loader-text").innerText = "BUILDING NETWORK GRAPH... 50%";
      if (progressBar) progressBar.style.width = "50%";
      await sleep(10);

      window.IS_IMPORTED_NETWORK = true;
      if (typeof window.resetClustersState === "function") {
        window.resetClustersState();
      }
      window.CLUSTERS_ENABLED = false;
      if (typeof window.clearPromoterMotifAnalysis === "function") {
        window.clearPromoterMotifAnalysis(true);
      } else {
        VISIBILITY_STATE.EdgeBoth = 0;
      }
      if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();

      const nameDisplay = document.getElementById('import-edges-name');
      const infoDisplay = document.getElementById('import-edges-info');
      if (nameDisplay && infoDisplay) {
          nameDisplay.innerText = fileName;
          infoDisplay.style.display = 'flex';
      }
      const jsonInfo = document.getElementById('import-json-info');
      if (jsonInfo) jsonInfo.style.display = 'none';

      const text = e.target.result;
      const rawLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      // Parse optional Rice2Net cluster metadata comments (#RICE2NET_*) and strip comment lines
      let importedClusterMeta = null;
      const importedClusterDefs = new Map(); // clusterId -> { id, name, color, genes: Set }
      const lines = [];

      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (line.startsWith("#RICE2NET_CLUSTERS_META\t")) {
          try {
            importedClusterMeta = JSON.parse(line.slice("#RICE2NET_CLUSTERS_META\t".length));
          } catch (err) {}
          continue;
        }
        if (line.startsWith("#RICE2NET_CLUSTER\t")) {
          const parts = line.split("\t");
          if (parts.length >= 3) {
            const cid = parts[1].trim();
            const cname = parts[2].trim();
            const ccolor = parts[3] ? parts[3].trim() : null;
            if (cid) {
              importedClusterDefs.set(cid, {
                id: cid,
                name: cname || cid,
                color: ccolor || null,
                customColor: Boolean(ccolor),
                genes: new Set(),
              });
            }
          }
          continue;
        }
        if (line.trim().startsWith("#")) continue;
        lines.push(line);
      }

      if (lines.length === 0) {
        alert("No valid edges found.");
        loader.style.display = "none";
        return;
      }

      const edgeMap = new Map();
      const nodeSet = new Set();

      let colMap = {
        source: 0,
        target: 1,
        weight: 2,
        zScore: -1,
        sign: -1,
        sourceCluster: -1,
        targetCluster: -1,
      };

      const firstLine = lines[0].trim();
      let delimiter = "\t";
      if (firstLine.includes("\t")) {
        delimiter = "\t";
      } else if (firstLine.includes(",")) {
        delimiter = ",";
      } else {
        delimiter = /\s+/;
      }

      const splitLine = (l) => {
        if (delimiter === ",") {
          return l.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
        } else if (delimiter === "\t") {
          return l.split("\t").map(s => s.trim());
        } else {
          return l.trim().split(/\s+/);
        }
      };

      let hasHeader = false;
      let startIdx = 0;
      if (lines.length > 0) {
        const firstParts = splitLine(lines[0]).map((h) => h.toLowerCase());
        hasHeader = firstParts.includes("source") || firstParts.includes("from") || firstParts.includes("target") || firstParts.includes("to");
        if (hasHeader) {
          colMap.weight = -1;
          firstParts.forEach((h, idx) => {
            if (h === "source" || h === "from") colMap.source = idx;
            else if (h === "target" || h === "to") colMap.target = idx;
            else if (h === "weight" || h === "w" || h === "val" || h === "value") colMap.weight = idx;
            else if (h === "z_score" || h === "zscore" || h === "z-score" || h === "z") colMap.zScore = idx;
            else if (h === "sign") colMap.sign = idx;
            else if (h === "source_cluster") colMap.sourceCluster = idx;
            else if (h === "target_cluster") colMap.targetCluster = idx;
          });
          startIdx = 1;
        }
      }

      const assignImportedCluster = (geneId, rawClusterVal) => {
        const cid = String(rawClusterVal || "").trim();
        if (!cid || cid === "-" || cid.toLowerCase() === "none") return;
        if (!importedClusterDefs.has(cid)) {
          importedClusterDefs.set(cid, {
            id: cid,
            name: cid,
            color: null,
            customColor: false,
            genes: new Set(),
          });
        }
        importedClusterDefs.get(cid).genes.add(geneId);
      };

      for (let i = startIdx; i < lines.length; i++) {
        const parts = splitLine(lines[i]);
        if (parts.length < 2) continue;

        const s = parts[colMap.source] ? parts[colMap.source].trim() : parts[0].trim();
        const t = parts[colMap.target] ? parts[colMap.target].trim() : parts[1].trim();
        if (!s || !t) continue;

        if (hasHeader) {
          if (colMap.sourceCluster !== -1 && parts[colMap.sourceCluster] !== undefined) {
            assignImportedCluster(s, parts[colMap.sourceCluster]);
          }
          if (colMap.targetCluster !== -1 && parts[colMap.targetCluster] !== undefined) {
            assignImportedCluster(t, parts[colMap.targetCluster]);
          }
        }

        let w = 1;
        let zScore = null;
        let sign = null;

        if (hasHeader) {
          if (colMap.weight !== -1 && parts[colMap.weight] !== undefined) {
            const parsedW = parseFloat(parts[colMap.weight]);
            if (!isNaN(parsedW)) w = parsedW;
          }
          if (colMap.zScore !== -1 && parts[colMap.zScore] !== undefined && parts[colMap.zScore].trim() !== "") {
            const parsedZ = parseFloat(parts[colMap.zScore]);
            if (!isNaN(parsedZ)) zScore = parsedZ;
          }
          if (colMap.sign !== -1 && parts[colMap.sign] !== undefined) {
            const rawSign = parts[colMap.sign].trim();
            if (rawSign === "+" || rawSign === "-" || rawSign.toLowerCase() === "positive" || rawSign.toLowerCase() === "negative" || rawSign === "+1" || rawSign === "-1") {
              sign = (rawSign === "-" || rawSign.toLowerCase() === "negative" || rawSign === "-1") ? "-" : "+";
            }
          }
        } else {
          // No header: dynamically scan columns after target (index 2 onwards)
          let assignedWeight = false;
          let assignedZScore = false;

          for (let col = 2; col < parts.length; col++) {
            const p = parts[col].trim();
            if (!p) continue;
            const pLower = p.toLowerCase();

            if (p === "+" || p === "-" || pLower === "positive" || pLower === "negative" || p === "+1" || p === "-1") {
              sign = (p === "-" || pLower === "negative" || p === "-1") ? "-" : "+";
            } else if (!isNaN(parseFloat(p))) {
              const num = parseFloat(p);
              if (!assignedWeight) {
                w = num;
                assignedWeight = true;
              } else if (!assignedZScore) {
                zScore = num;
                assignedZScore = true;
              }
            }
          }
        }

        const edgeKey = `${s}->${t}`;
        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, {
            source: s,
            target: t,
            weight: w,
            z_score: zScore,
            sign: sign,
            has_interacts: true,
            has_regulates: false,
            directions: null,
            reg_matched: false,
          });
        }

        nodeSet.add(s);
        nodeSet.add(t);
      }

      const newEdges = Array.from(edgeMap.values());

      if (newEdges.length === 0) {
        alert("No valid edges found.");
        loader.style.display = "none";
        return;
      }

      nodes = Array.from(nodeSet).map((id) => ({
        id: id,
        deg: 0,
        x: random() * width,
        y: random() * height,
        _hasLayoutPos: false,
      }));

      const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
      links = newEdges
        .map((e) => ({
          source: nodeMap.get(String(e.source)),
          target: nodeMap.get(String(e.target)),
          weight: e.weight,
          z_score: e.z_score !== undefined && e.z_score !== null ? e.z_score : null,
          sign: e.sign,
          has_interacts: e.has_interacts,
          has_regulates: false,
          directions: null,
          reg_matched: false,
        }))
        .filter((l) => l.source && l.target);

      await window.__APP_CORE__.hydrateMetadata();
      RAW_DATA.nodes = nodes;
      RAW_DATA.links = newEdges;
      RAW_DATA.workingNodes = nodes;
      RAW_DATA.workingLinks = null;
      if (typeof window.__APP_CORE__.cacheMetaSnapshot === "function") {
        window.__APP_CORE__.cacheMetaSnapshot();
      }
      RAW_DATA.adjacency = window.__APP_CORE__.buildAdjacency(nodes, links);
      RAW_DATA.fullAdjacency = RAW_DATA.adjacency;
      RAW_DATA._fullAdjacencyLinksRef = RAW_DATA.links;

      const hasZScore =
        typeof window.configureZScoreBounds === "function"
          ? window.configureZScoreBounds(RAW_DATA.links)
          : false;
      if (hasZScore && typeof window.applyEdgeFilter === "function") {
        window.applyEdgeFilter();
      }

      // Restore clusters parsed from TSV header/columns and run ORA-only re-analysis
      const importedItems = Array.from(importedClusterDefs.values())
        .filter((c) => c.genes.size > 0)
        .map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          customColor: c.customColor,
          genes: Array.from(c.genes),
        }));

      startCalculation(true);

      if (
        importedItems.length > 0 &&
        typeof window.loadImportedClustersAndRunOra === "function"
      ) {
        window.loadImportedClustersAndRunOra({
          pvalThreshold: (importedClusterMeta && importedClusterMeta.pvalThreshold) || 0.05,
          backgroundMode: (importedClusterMeta && importedClusterMeta.backgroundMode) || "network",
          annotatedOnly:
            importedClusterMeta && importedClusterMeta.annotatedOnly !== undefined
              ? importedClusterMeta.annotatedOnly
              : true,
          markovTime: (importedClusterMeta && importedClusterMeta.markovTime) || null,
          items: importedItems,
        });
      }

      if (typeof window.showDemoImportNotice === "function") {
        window.showDemoImportNotice();
      }
    };
    reader.readAsText(input.files[0]);
  }, 50);
};

/**
 * Enables drag-and-drop custom file import (.json, .tsv, .csv, .txt) onto the app canvas.
 */
(function initDragAndDropImport() {
  const target = document.getElementById("container") || document.body;
  if (!target || typeof target.addEventListener !== "function") return;

  let dragDepth = 0;
  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "drop-import-overlay";
    overlay.innerHTML = `<div class="drop-import-card">Drop <code>.json</code> layout or <code>.tsv</code> / <code>.csv</code> / <code>.txt</code> edge table to import</div>`;
    target.appendChild(overlay);
    return overlay;
  }

  function hasFiles(e) {
    return (
      e.dataTransfer &&
      e.dataTransfer.types &&
      Array.from(e.dataTransfer.types).includes("Files")
    );
  }

  target.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    ensureOverlay().style.display = "flex";
  });

  target.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  target.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.style.display = "none";
  });

  target.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.style.display = "none";

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const file = files[0];
    const name = String(file.name || "").toLowerCase();

    if (name.endsWith(".json")) {
      window.importJSON({ files: [file] });
    } else if (
      name.endsWith(".tsv") ||
      name.endsWith(".csv") ||
      name.endsWith(".txt")
    ) {
      window.importEdges({ files: [file] });
    } else {
      alert("Unsupported file format. Drop a .json layout or .tsv/.csv/.txt edge file.");
    }
  });
})();

/**
 * Runs localized D3 force simulation for a subset of affected node IDs.
 * Delegates degree, visual, and physics updates to sim.js helpers.
 * @param {Array<string>} affectedIds - Node IDs allowed to move.
 */
window.runLocalPhysics = function (affectedIds) {
  if (!simulation) return;

  const affectedSet = new Set(affectedIds);

  nodes.forEach((n) => {
    if (!affectedSet.has(String(n.id))) {
      n.fx = n.x !== undefined ? n.x : width / 2;
      n.fy = n.y !== undefined ? n.y : height / 2;
    } else {
      n.fx = null;
      n.fy = null;
    }
  });

  if (typeof calculateDegrees === "function") calculateDegrees();
  if (typeof updateVisualProps === "function") updateVisualProps();
  if (typeof updatePhysicsParams === "function") updatePhysicsParams();

  simulation.nodes(nodes);
  simulation.force("link").links(links);

  simulation.on("tick", () => {
    requestAnimationFrame(window.draw);
  });

  simulation.on("end", () => {
    nodes.forEach((n) => {
      n.fx = null;
      n.fy = null;
    });
    simulation.on("tick", null);
    simulation.on("end", null);

    if (typeof window.rebuildInteractiveQuadtree === "function") {
      window.rebuildInteractiveQuadtree();
    } else if (typeof d3 !== "undefined") {
      quadtree = d3.quadtree().x((d) => d.x).y((d) => d.y).addAll(nodes);
    }
  });

  simulation.alpha(0.5).restart();
};
