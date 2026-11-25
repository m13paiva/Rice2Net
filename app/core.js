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
  document.getElementById("loader-text").innerText = "LOADING JSON... 0%";
  if (progressBar) progressBar.style.width = "0%";

  setTimeout(() => {
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const json = JSON.parse(e.target.result);
        if (!json.nodes || !json.edges)
          throw new Error("Invalid JSON structure");

        window.IS_IMPORTED_NETWORK = true;
        VISIBILITY_STATE.EdgeBoth = 0;
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

        document.getElementById("loader-text").innerText = "LOADING JSON... 50%";
        if (progressBar) progressBar.style.width = "50%";

        links = json.edges
          .map((e) => {
            const sId = String(e.source?.id || e.source);
            const tId = String(e.target?.id || e.target);
            const sNode = nodeMap.get(sId);
            const tNode = nodeMap.get(tId);
            if (!sNode || !tNode) return null;

            return {
              source: sNode,
              target: tNode,
              weight:
                e.weight !== undefined && e.weight !== null
                  ? e.weight
                  : e.value !== undefined && e.value !== null
                  ? e.value
                  : 1,
              irp: e.irp !== undefined && e.irp !== null ? e.irp : null,
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
        RAW_DATA.workingLinks = links;
        if (typeof window.__APP_CORE__.cacheMetaSnapshot === "function") {
          window.__APP_CORE__.cacheMetaSnapshot();
        }
        RAW_DATA.adjacency = window.__APP_CORE__.buildAdjacency(nodes, links);
        RAW_DATA.fullAdjacency = RAW_DATA.adjacency;
        RAW_DATA._fullAdjacencyLinksRef = RAW_DATA.links;

        if (loader) loader.style.display = "none";
        finishSetup(true);
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
  document.getElementById("loader-text").innerText = "READING EDGE TABLE... 0%";
  if (progressBar) progressBar.style.width = "0%";

  setTimeout(() => {
    const reader = new FileReader();
    reader.onload = async function (e) {
      document.getElementById("loader-text").innerText = "PARSING GRAPH... 50%";
      if (progressBar) progressBar.style.width = "50%";
      await sleep(10);

      window.IS_IMPORTED_NETWORK = true;
      VISIBILITY_STATE.EdgeBoth = 0;
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
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
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
        irp: -1,
        sign: -1,
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
            else if (h === "irp_score" || h === "irp") colMap.irp = idx;
            else if (h === "sign") colMap.sign = idx;
          });
          startIdx = 1;
        }
      }

      for (let i = startIdx; i < lines.length; i++) {
        const parts = splitLine(lines[i]);
        if (parts.length < 2) continue;

        const s = parts[colMap.source] ? parts[colMap.source].trim() : parts[0].trim();
        const t = parts[colMap.target] ? parts[colMap.target].trim() : parts[1].trim();
        if (!s || !t) continue;

        let w = 1;
        let irp = null;
        let sign = null;

        if (hasHeader) {
          if (colMap.weight !== -1 && parts[colMap.weight] !== undefined) {
            const parsedW = parseFloat(parts[colMap.weight]);
            if (!isNaN(parsedW)) w = parsedW;
          }
          if (colMap.irp !== -1 && parts[colMap.irp] !== undefined) {
            const parsedIRP = parseFloat(parts[colMap.irp]);
            if (!isNaN(parsedIRP)) irp = parsedIRP;
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
          let assignedIRP = false;

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
              } else if (!assignedIRP) {
                irp = num;
                assignedIRP = true;
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
            irp: irp,
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
      }));

      const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
      links = newEdges
        .map((e) => ({
          source: nodeMap.get(String(e.source)),
          target: nodeMap.get(String(e.target)),
          weight: e.weight,
          irp: e.irp,
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
      RAW_DATA.workingLinks = links;
      if (typeof window.__APP_CORE__.cacheMetaSnapshot === "function") {
        window.__APP_CORE__.cacheMetaSnapshot();
      }
      RAW_DATA.adjacency = window.__APP_CORE__.buildAdjacency(nodes, links);
      RAW_DATA.fullAdjacency = RAW_DATA.adjacency;
      RAW_DATA._fullAdjacencyLinksRef = RAW_DATA.links;
      startCalculation(true);
    };
    reader.readAsText(input.files[0]);
  }, 50);
};

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

    if (typeof d3 !== "undefined") {
      quadtree = d3.quadtree().x((d) => d.x).y((d) => d.y).addAll(nodes);
    }
  });

  simulation.alpha(0.5).restart();
};
