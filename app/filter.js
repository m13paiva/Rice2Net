/**
 * filter.js - Subnetwork Extraction & Filtering Domain Module
 * 
 * Implements target gene subnetwork extraction, neighborhood expansion by search depth,
 * leaf pruning algorithms, single-node contraction/expansion/pop operations, and network restoration.
 */

window.__APP_CORE__ = window.__APP_CORE__ || {};

/**
 * Standard utility to parse raw user target input strings into an array of distinct target tokens.
 * Handles newlines, tabs, commas, and safely handles rice symbols containing semicolons (e.g. HKT1;5).
 * @param {string|Array<string>} rawInput - Input target text or array of strings.
 * @returns {Array<string>} Cleaned array of target search tokens.
 */
window.parseRawTargets = function (rawInput) {
  if (!rawInput) return [];
  const inputList = Array.isArray(rawInput) ? rawInput : [rawInput];
  const results = [];
  inputList.forEach((item) => {
    if (!item) return;
    String(item)
      .split(/[\r\n,\t]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => {
        if (s.includes(";") && !/^[A-Za-z0-9_]+;\d+$/i.test(s)) {
          s.split(/;\s*/).map((p) => p.trim()).filter(Boolean).forEach((p) => {
            if (!results.includes(p)) results.push(p);
          });
        } else {
          if (!results.includes(s)) results.push(s);
        }
      });
  });
  return results;
};

/**
 * Resolves user target strings (RAP IDs, MSU IDs, and Gene Identifiers/Symbols) to internal node IDs.
 * Supports exact IDs, MSU isoform-stripped IDs, gene identifiers, and gene symbols.
 * @param {Array<string>} rawTargets - Array of raw input target identifiers.
 * @returns {Set<string>} Set of resolved internal node IDs.
 */
window.resolveTargetIds = function (rawTargets) {
  const resolved = new Set();
  if (!rawTargets) return resolved;

  const expandedTargets = window.parseRawTargets(rawTargets);
  if (expandedTargets.length === 0) return resolved;

  const normalize = (s) => String(s || "").trim().toLowerCase();
  const normalizeMsu = (s) => normalize(s).replace(/^loc_/, "").replace(/\.\d+$/, "");

  const targetSet = new Set(expandedTargets.map(normalize));
  const targetMsuSet = new Set(expandedTargets.map(normalizeMsu));

  const matchesTarget = (val, isMsu = false) => {
    if (!val || val === "." || val === "-" || val === "null" || val === "none") return false;
    const nVal = normalize(val);
    if (targetSet.has(nVal)) return true;
    if (isMsu || nVal.startsWith("loc_os") || /^os\d{2}g\d{5}/i.test(nVal)) {
      if (targetMsuSet.has(normalizeMsu(nVal))) return true;
    }
    return false;
  };

  const checkNode = (n) => {
    if (!n) return;
    const id = String(n.id);
    if (matchesTarget(id)) { resolved.add(id); return; }
    if (n.rap_id && matchesTarget(n.rap_id)) { resolved.add(id); return; }
    if (n.msu_id && matchesTarget(n.msu_id, true)) { resolved.add(id); return; }
    if (n.identifier && matchesTarget(n.identifier)) { resolved.add(id); return; }
    if (n.symbol && matchesTarget(n.symbol)) { resolved.add(id); return; }

    if (n.metadata) {
      const meta = n.metadata;
      const keys = ["MSU_ID", "MSU ID", "msu_id", "RAP_ID", "RAP ID", "Identifier", "identifier", "Symbol", "symbol"];
      for (const k of keys) {
        if (meta[k]) {
          const parts = String(meta[k]).split(/[,;\t]+/).map(s => s.trim()).filter(Boolean);
          if (parts.some(p => matchesTarget(p, k.toUpperCase().includes("MSU")))) {
            resolved.add(id);
            return;
          }
        }
      }
    }
  };

  if (Array.isArray(nodes)) nodes.forEach(checkNode);
  if (RAW_DATA && Array.isArray(RAW_DATA.nodes)) RAW_DATA.nodes.forEach(checkNode);
  if (RAW_DATA && Array.isArray(RAW_DATA.dbNodes)) RAW_DATA.dbNodes.forEach(checkNode);

  if (RAW_DATA && RAW_DATA.metaById) {
    RAW_DATA.metaById.forEach((meta, id) => {
      if (resolved.has(id)) return;
      if (matchesTarget(id)) { resolved.add(id); return; }
      if (meta.identifier && matchesTarget(meta.identifier)) { resolved.add(id); return; }
      if (meta.msu_id && matchesTarget(meta.msu_id, true)) { resolved.add(id); return; }
      if (meta.symbol && matchesTarget(meta.symbol)) { resolved.add(id); return; }
      if (meta.metadata) {
        const keys = ["MSU_ID", "MSU ID", "msu_id", "RAP_ID", "RAP ID", "Identifier", "identifier", "Symbol", "symbol"];
        for (const k of keys) {
          if (meta.metadata[k]) {
            const parts = String(meta.metadata[k]).split(/[,;\t]+/).map(s => s.trim()).filter(Boolean);
            if (parts.some(p => matchesTarget(p, k.toUpperCase().includes("MSU")))) {
              resolved.add(id);
              return;
            }
          }
        }
      }
    });
  }

  return resolved;
};

/**
 * Copies cached metadata properties onto a target node object.
 * @param {Object} n - Target node object.
 */
function applyMetaToNode(n) {
  const m = RAW_DATA.metaById && RAW_DATA.metaById.get(n.id);
  if (m) {
    n.originalType = m.originalType || n.originalType || "Gene";
    n.metadata = { ...m.metadata };
    n.tfDetail = (m.tfDetail || []).map((x) => ({ ...x }));
    n.keggDetail = (m.keggDetail || []).map((x) => ({ ...x }));
  } else {
    n.originalType = n.originalType || "Gene";
    n.metadata = n.metadata || {};
    n.tfDetail = n.tfDetail || [];
    n.keggDetail = n.keggDetail || [];
    n.symbol = n.symbol || "";
  }
}

/**
 * Applies visual styling specifications onto a target node object.
 * @param {Object} n - Target node object.
 */
function applyTypeStyling(n) {
  if (window.applyNodeTypeStyling) {
    window.applyNodeTypeStyling(n);
    return;
  }

  if (n.originalType === "TF") {
    n.color = CONFIG.visuals.colors.TF;
    n.shape = "diamond";
    n.typeLabel = "Transcription Factor";
  } else {
    n.color = CONFIG.visuals.colors.Gene;
    n.shape = "circle";
    n.typeLabel = "Gene";
  }
}

/**
 * Removes a single node from the active subnetwork view.
 * @param {string} nodeId - Target node ID to remove.
 */
window.popNode = function(nodeId) {
    if (window.IS_IMPORTED_NETWORK) return;

    if (!RAW_DATA.workingNodes) RAW_DATA.workingNodes = [...RAW_DATA.nodes];
    if (!RAW_DATA.workingLinks) RAW_DATA.workingLinks = [...RAW_DATA.links];

    const activeNode = nodes.find(n => String(n.id) === String(nodeId));
    if (!activeNode) return;

    const affectedIds = new Set();
    links.forEach(l => {
        const s = String(l.source.id || l.source);
        const t = String(l.target.id || l.target);
        if (s === String(nodeId)) affectedIds.add(t);
        if (t === String(nodeId)) affectedIds.add(s);
    });

    RAW_DATA.workingNodes = RAW_DATA.workingNodes.filter(n => String(n.id) !== String(nodeId));
    RAW_DATA.workingLinks = RAW_DATA.workingLinks.filter(l =>
        String(l.source.id || l.source) !== String(nodeId) &&
        String(l.target.id || l.target) !== String(nodeId)
    );

    window.IS_FILTERED_NETWORK = true;
    if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();
    if (typeof window.applyEdgeFilter === "function") window.applyEdgeFilter();

    if (typeof window.runLocalPhysics === "function") {
        window.runLocalPhysics(Array.from(affectedIds));
    }
};

/**
 * Contracts leaf connections attached to a target node.
 * @param {string} nodeId - Target node ID to contract.
 */
window.contractNode = function(nodeId) {
    if (window.IS_IMPORTED_NETWORK) return;

    if (!RAW_DATA.workingNodes) RAW_DATA.workingNodes = [...RAW_DATA.nodes];
    if (!RAW_DATA.workingLinks) RAW_DATA.workingLinks = [...RAW_DATA.links];

    const activeNode = nodes.find(n => String(n.id) === String(nodeId));
    if (!activeNode) return;

    const uniqueNeighbors = new Map();
    nodes.forEach(n => uniqueNeighbors.set(String(n.id), new Set()));
    links.forEach(l => {
        const s = String(l.source.id || l.source);
        const t = String(l.target.id || l.target);
        if (s !== t) {
            if (uniqueNeighbors.has(s)) uniqueNeighbors.get(s).add(t);
            if (uniqueNeighbors.has(t)) uniqueNeighbors.get(t).add(s);
        }
    });

    const myNeighbors = uniqueNeighbors.get(String(nodeId)) || new Set();
    const isLeaf = myNeighbors.size <= 1;

    if (isLeaf) {
        window.popNode(nodeId);
        return;
    }

    const leavesToRemove = new Set();
    myNeighbors.forEach(neighborId => {
        if (uniqueNeighbors.get(neighborId)?.size === 1) {
            leavesToRemove.add(neighborId);
        }
    });

    if (leavesToRemove.size === 0) return;

    const affectedIds = new Set([String(nodeId)]);

    RAW_DATA.workingNodes = RAW_DATA.workingNodes.filter(n => !leavesToRemove.has(String(n.id)));
    RAW_DATA.workingLinks = RAW_DATA.workingLinks.filter(l => {
        const s = String(l.source.id || l.source);
        const t = String(l.target.id || l.target);
        return !leavesToRemove.has(s) && !leavesToRemove.has(t);
    });

    window.IS_FILTERED_NETWORK = true;
    if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();
    if (typeof window.applyEdgeFilter === "function") window.applyEdgeFilter();

    if (typeof window.runLocalPhysics === "function") {
        window.runLocalPhysics(Array.from(affectedIds));
    }
};

/**
 * Expands a target node by adding back its missing 1st-degree neighbors from the master topology.
 * @param {string} nodeId - Target node ID to expand.
 */
window.expandNode = function(nodeId) {
    if (window.IS_IMPORTED_NETWORK) return;

    if (!RAW_DATA.workingNodes) RAW_DATA.workingNodes = [...RAW_DATA.nodes];
    if (!RAW_DATA.workingLinks) RAW_DATA.workingLinks = [...RAW_DATA.links];

    const targetNode = RAW_DATA.workingNodes.find(n => String(n.id) === String(nodeId));
    if (!targetNode) return;

    const activeNode = nodes.find(n => String(n.id) === String(nodeId));
    if (!activeNode) return;

    const fullNeighbors = new Set();
    RAW_DATA.links.forEach(l => {
        const s = String(l.source.id || l.source);
        const t = String(l.target.id || l.target);
        if (s === String(nodeId)) fullNeighbors.add(t);
        if (t === String(nodeId)) fullNeighbors.add(s);
    });

    const currentWorkingIds = new Set(RAW_DATA.workingNodes.map(n => String(n.id)));
    const newNeighborIds = new Set([...fullNeighbors].filter(id => !currentWorkingIds.has(id)));

    if (newNeighborIds.size === 0) return;

    const nodesToAdd = [];
    const affectedIds = new Set([String(nodeId)]);

    links.forEach(l => {
        const s = String(l.source.id || l.source);
        const t = String(l.target.id || l.target);
        if (s === String(nodeId)) affectedIds.add(t);
        if (t === String(nodeId)) affectedIds.add(s);
    });

    RAW_DATA.nodes.forEach(n => {
        if (newNeighborIds.has(String(n.id))) {
            const nn = { ...n, x: activeNode.x + (Math.random() * 20 - 10), y: activeNode.y + (Math.random() * 20 - 10), vx: 0, vy: 0 };
            if (typeof applyMetaToNode === "function") applyMetaToNode(nn);
            if (typeof applyTypeStyling === "function") applyTypeStyling(nn);
            nodesToAdd.push(nn);
            currentWorkingIds.add(String(n.id));
            affectedIds.add(String(n.id));
        }
    });

    RAW_DATA.workingNodes.push(...nodesToAdd);

    const connectNeighbors = document.getElementById("target-cross-edges") ? document.getElementById("target-cross-edges").checked : true;

    const existingWorkingLinkKeys = new Set(
        RAW_DATA.workingLinks.map(l => {
            const s = String(l.source.id || l.source);
            const t = String(l.target.id || l.target);
            return s < t ? `${s}-${t}` : `${t}-${s}`;
        })
    );

    const newEdges = [];
    RAW_DATA.links.forEach(l => {
        const s = String(l.source.id || l.source);
        const t = String(l.target.id || l.target);
        const key = s < t ? `${s}-${t}` : `${t}-${s}`;

        if (existingWorkingLinkKeys.has(key)) return;

        const sIsNew = newNeighborIds.has(s);
        const tIsNew = newNeighborIds.has(t);

        if ((s === String(nodeId) && tIsNew) || (t === String(nodeId) && sIsNew)) {
            newEdges.push(l);
            existingWorkingLinkKeys.add(key);
        }
        else if (connectNeighbors) {
            if ((sIsNew && currentWorkingIds.has(t)) || (tIsNew && currentWorkingIds.has(s))) {
                newEdges.push(l);
                existingWorkingLinkKeys.add(key);
                affectedIds.add(s);
                affectedIds.add(t);
            }
        }
    });

    RAW_DATA.workingLinks.push(...newEdges);

    window.IS_FILTERED_NETWORK = true;
    if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();
    if (typeof window.applyEdgeFilter === "function") window.applyEdgeFilter();

    if (typeof window.runLocalPhysics === "function") {
        window.runLocalPhysics(Array.from(affectedIds));
    }
};

/**
 * Restores the subnetwork view back to full master network topology.
 */
window.resetToFull = async function () {
  const loader = document.getElementById("loader");
  const progressBar = document.getElementById("progress-bar");
  const loaderText = document.getElementById("loader-text");

  loader.style.display = "block";
  loaderText.innerText = "RESTORING NETWORK... 0%";
  progressBar.style.width = "0%";
  await sleep(50);

  if (typeof window.updateIRPControlUI === "function") {
    window.updateIRPControlUI(0);
  }

  if (simulation) simulation.stop();

  const text = document.getElementById("target-input").value;
  const rawTargets = window.parseRawTargets
    ? window.parseRawTargets(text)
    : text.split(/[\r\n,\t]+/).map((s) => s.trim()).filter(Boolean);

  const targetSet = window.resolveTargetIds(rawTargets);
  const hasTargets = targetSet.size > 0;

  document.getElementById("legend-target").style.display = hasTargets
    ? "flex"
    : "none";

  const hasCachedPos =
    RAW_DATA.nodes.length > 0 && RAW_DATA.nodes[0].x !== undefined;

  nodes = [];
  const totalN = RAW_DATA.nodes.length;
  const chunkSize = 5000;

  const w = typeof width !== "undefined" ? width : window.innerWidth || 1000;
  const h = typeof height !== "undefined" ? height : window.innerHeight || 1000;

  rng = mulberry32(typeof _seed !== "undefined" ? _seed : 42);

  for (let i = 0; i < totalN; i += chunkSize) {
    const slice = RAW_DATA.nodes.slice(i, i + chunkSize);
    const chunk = slice.map((n) => {
      const newNode = hasCachedPos
        ? { ...n }
        : { ...n, x: w / 2 + random(), y: h / 2 + random(), vx: 0, vy: 0 };
      applyMetaToNode(newNode);
      applyTypeStyling(newNode);
      if (hasTargets && targetSet.has(newNode.id)) {
        newNode.color =
          typeof CONFIG !== "undefined" && CONFIG.visuals
            ? CONFIG.visuals.colors.Green
            : "#00ff00";
        newNode.typeLabel = "Target Gene";
        newNode.strokeColor = "#ffffff";
        newNode.strokeWidth = 2;
      }
      return newNode;
    });
    nodes.push(...chunk);

    const pct = Math.round(((i + chunkSize) / totalN) * 100);
    progressBar.style.width = pct + "%";
    loaderText.innerText = `RESTORING NETWORK... ${Math.min(pct, 100)}%`;
    await sleep(10);
  }

  RAW_DATA.workingNodes = nodes;
  RAW_DATA.workingLinks = null;

  window.IS_FILTERED_NETWORK = false;
  if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();

  if (typeof window.applyEdgeFilter === "function") {
    window.applyEdgeFilter();
  }

  if (hasCachedPos) {
    loaderText.innerText = "INSTANT LOAD...";
    await sleep(50);
    loader.style.display = "none";
    finishSetup(true);
  } else {
    startCalculation(true);
  }
};

/**
 * Extracts a subnetwork centered around user-specified target genes up to a specified depth.
 */
window.runFilter = async function () {
  const text = document.getElementById("target-input").value;
  if (!text.trim()) {
    alert("Please enter target genes.");
    return;
  }

  const rawTargets = window.parseRawTargets
    ? window.parseRawTargets(text)
    : text.split(/[\r\n,\t]+/).map((s) => s.trim()).filter(Boolean);

  const targetSet = window.resolveTargetIds(rawTargets);

  let parsedDepth = parseInt(document.getElementById("target-depth").value);
  const depth = isNaN(parsedDepth) ? 1 : Math.max(0, parsedDepth);

  const prune = document.getElementById("target-prune").checked;
  const connectNeighbors = document.getElementById("target-cross-edges")
    ? document.getElementById("target-cross-edges").checked
    : true;

  const loader = document.getElementById("loader");
  const progressBar = document.getElementById("progress-bar");
  loader.style.display = "block";
  document.getElementById("loader-text").innerText = "FILTERING NETWORK...";
  if (progressBar) progressBar.style.width = "100%";
  await sleep(50);

  if (typeof window.updateIRPControlUI === "function") {
    window.updateIRPControlUI(0);
  }

  const fullAdjacency = window.__APP_CORE__.buildAdjacency(
    RAW_DATA.nodes,
    RAW_DATA.links,
  );

  const startNodes = new Set();
  targetSet.forEach((t) => {
    if (fullAdjacency.has(t)) startNodes.add(t);
  });

  if (startNodes.size === 0) {
    alert(`No valid targets found.\nChecked ${rawTargets.length} IDs.`);
    loader.style.display = "none";
    return;
  }

  const keptEdgeIndices = new Set();
  const visitedNodes = new Set(startNodes);
  let currentLayer = new Set(startNodes);

  for (let i = 0; i < depth; i++) {
    if (currentLayer.size === 0) break;
    const nextLayer = new Set();
    for (const nodeId of currentLayer) {
      const neighbors = fullAdjacency.get(nodeId) || [];
      for (const edgeObj of neighbors) {
        if (!connectNeighbors) {
          keptEdgeIndices.add(edgeObj.idx);
        }
        if (!visitedNodes.has(edgeObj.n)) {
          visitedNodes.add(edgeObj.n);
          nextLayer.add(edgeObj.n);
        }
      }
    }
    currentLayer = nextLayer;
  }

  if (connectNeighbors) {
    visitedNodes.forEach((nodeId) => {
      const neighbors = fullAdjacency.get(nodeId) || [];
      for (const edgeObj of neighbors) {
        if (visitedNodes.has(edgeObj.n)) {
          keptEdgeIndices.add(edgeObj.idx);
        }
      }
    });
  }

  if (keptEdgeIndices.size === 0) {
    if (startNodes.size > 0) {
      if (typeof VISIBILITY_STATE !== "undefined") {
        VISIBILITY_STATE.Rogue = 2;
      }
      const rogueCheckbox = document.getElementById("vis-Rogue");
      if (rogueCheckbox) rogueCheckbox.checked = true;
    } else {
      alert("No edges found.");
      loader.style.display = "none";
      return;
    }
  }

  if (prune && keptEdgeIndices.size > 0) {
    const localAdj = new Map();
    const edgeMap = new Map();
    for (const idx of keptEdgeIndices) {
      const l = RAW_DATA.links[idx];
      const s = l.source?.id || l.source;
      const t = l.target?.id || l.target;
      if (!localAdj.has(s)) localAdj.set(s, new Set());
      if (!localAdj.has(t)) localAdj.set(t, new Set());
      localAdj.get(s).add(t);
      localAdj.get(t).add(s);
      edgeMap.set(idx, [s, t]);
    }

    const queue = [];
    localAdj.forEach((neighbors, id) => {
      if (neighbors.size === 1 && !startNodes.has(id)) queue.push(id);
    });

    const removedNodes = new Set();
    while (queue.length > 0) {
      const u = queue.shift();
      removedNodes.add(u);
      const neighbors = localAdj.get(u);
      if (!neighbors) continue;
      for (const v of neighbors) {
        if (removedNodes.has(v)) continue;
        const vNeighbors = localAdj.get(v);
        vNeighbors.delete(u);
        if (vNeighbors.size === 1 && !startNodes.has(v)) queue.push(v);
      }
    }

    const prunedIndices = new Set();
    for (const idx of keptEdgeIndices) {
      const [s, t] = edgeMap.get(idx);
      if (!removedNodes.has(s) && !removedNodes.has(t)) prunedIndices.add(idx);
    }
    keptEdgeIndices.clear();
    prunedIndices.forEach((x) => keptEdgeIndices.add(x));
  }

  const finalNodeIds = new Set();
  const subgraphLinks = [];

  for (const idx of keptEdgeIndices) {
    const l = RAW_DATA.links[idx];
    const s = l.source?.id || l.source;
    const t = l.target?.id || l.target;
    finalNodeIds.add(s);
    finalNodeIds.add(t);
    subgraphLinks.push(l);
  }

  const w = typeof width !== "undefined" ? width : window.innerWidth || 1000;
  const h = typeof height !== "undefined" ? height : window.innerHeight || 1000;

  rng = mulberry32(typeof _seed !== "undefined" ? _seed : 42);

  const subNodes = RAW_DATA.nodes
    .filter((n) => finalNodeIds.has(n.id))
    .map((n) => {
      const newNode = {
        ...n,
        x: w / 2 + random(),
        y: h / 2 + random(),
        vx: 0,
        vy: 0,
      };
      applyMetaToNode(newNode);
      applyTypeStyling(newNode);
      if (startNodes.has(newNode.id)) {
        newNode.color =
          typeof CONFIG !== "undefined" && CONFIG.visuals
            ? CONFIG.visuals.colors.Green
            : "#00ff00";
        newNode.typeLabel = "Target Gene";
        newNode.strokeColor = "#ffffff";
        newNode.strokeWidth = 2;
      }
      return newNode;
    });

  const subNodesMap = new Set(subNodes.map((n) => n.id));
  targetSet.forEach((tId) => {
    if (!subNodesMap.has(tId)) {
      const originalNode = (RAW_DATA.nodes && RAW_DATA.nodes.find((n) => n.id === tId)) || (RAW_DATA.dbNodes && RAW_DATA.dbNodes.find((n) => n.id === tId));
      if (originalNode) {
        const newNode = {
          ...originalNode,
          x: w / 2 + (random() * 50 - 25),
          y: h / 2 + (random() * 50 - 25),
          vx: 0,
          vy: 0,
          isRogue: true,
        };
        applyMetaToNode(newNode);
        applyTypeStyling(newNode);

        newNode.color =
          typeof CONFIG !== "undefined" && CONFIG.visuals
            ? CONFIG.visuals.colors.Green
            : "#00ff00";
        newNode.typeLabel = "Target Gene";
        newNode.strokeColor = "#ffffff";
        newNode.strokeWidth = 2;

        subNodes.push(newNode);
      }
    }
  });

  RAW_DATA.workingNodes = subNodes;
  RAW_DATA.workingLinks = subgraphLinks;

  document.getElementById("legend-target").style.display = "flex";

  window.IS_FILTERED_NETWORK = true;
  if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();

  if (typeof window.applyEdgeFilter === "function") {
    window.applyEdgeFilter();
  }

  loader.style.display = "none";

  startCalculation(true);
};
