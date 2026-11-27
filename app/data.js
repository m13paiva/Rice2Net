/**
 * data.js - Data Ingestion, Filtering, and API Integration Module
 * 
 * Handles network data initialization from the backend API, batch regulation edge fetching,
 * functional cluster metadata loading, node metadata hydration, and subnetwork filtering.
 */

window.__APP_CORE__ = window.__APP_CORE__ || {};

window.IS_IMPORTED_NETWORK = false;
window.IS_FILTERED_NETWORK = false;

/** Dynamic CSS rule to control cluster legend display based on network availability */
const clusterStyle = document.createElement("style");
clusterStyle.innerHTML = `body.hide-clusters #legend-clusters { display: none !important; }`;
document.head.appendChild(clusterStyle);

/**
 * Updates cluster legend availability state based on filtering and custom import status.
 */
window.updateClusterAvailability = function () {
  if (
    (CLUSTER_STATE.source === "discovered" || CLUSTER_STATE.source === "imported") &&
    CLUSTER_STATE.legend.length > 0
  ) {
    window.CLUSTERS_ENABLED = true;
    CLUSTER_STATE.isAvailable = true;
    document.body.classList.remove("hide-clusters");
    if (typeof window.renderClusterLegend === "function") window.renderClusterLegend();
    return;
  }

  if (!window.CLUSTERS_ENABLED || CLUSTER_STATE.legend.length === 0) {
    CLUSTER_STATE.isAvailable = false;
    document.body.classList.add("hide-clusters");
    if (CLUSTER_STATE.active.size > 0) CLUSTER_STATE.active.clear();
    if (typeof window.renderClusterLegend === "function") window.renderClusterLegend();
    return;
  }

  const isFiltered = window.IS_FILTERED_NETWORK || (nodes.length > 0 && RAW_DATA.nodes && nodes.length < RAW_DATA.nodes.length);
  CLUSTER_STATE.isAvailable = !(window.IS_IMPORTED_NETWORK || isFiltered);

  if (!CLUSTER_STATE.isAvailable) {
    document.body.classList.add("hide-clusters");
    if (CLUSTER_STATE.active.size > 0) {
        CLUSTER_STATE.active.clear();
        if (typeof window.reapplyColors === "function") window.reapplyColors();
    }
  } else {
    document.body.classList.remove("hide-clusters");
    if (typeof window.renderClusterLegend === "function") window.renderClusterLegend();
  }
};

/**
 * Builds an adjacency matrix mapping node IDs to their connected neighbors and link indices.
 * @param {Array<Object>} nodeList - Array of node objects.
 * @param {Array<Object>} linkList - Array of edge link objects.
 * @returns {Map<string, Array<{n: string, idx: number}>>} Adjacency map.
 */
function buildAdjacency(nodeList, linkList) {
  const adj = new Map();
  nodeList.forEach((n) => adj.set(String(n.id), []));

  linkList.forEach((l, idx) => {
    const s = String(l.source?.id || l.source);
    const t = String(l.target?.id || l.target);
    if (adj.has(s) && adj.has(t)) {
      adj.get(s).push({ n: t, idx });
      adj.get(t).push({ n: s, idx });
    }
  });

  return adj;
}

/**
 * Returns a cached adjacency map for the full active master topology (RAW_DATA.nodes/links),
 * rebuilding only when RAW_DATA.links reference changes (init, import, or revert).
 * @returns {Map<string, Array<{n: string, idx: number}>>} Full adjacency map.
 */
function getFullAdjacency() {
  if (
    RAW_DATA.fullAdjacency &&
    RAW_DATA._fullAdjacencyLinksRef === RAW_DATA.links
  ) {
    return RAW_DATA.fullAdjacency;
  }
  RAW_DATA.fullAdjacency = buildAdjacency(
    RAW_DATA.nodes || [],
    RAW_DATA.links || []
  );
  RAW_DATA._fullAdjacencyLinksRef = RAW_DATA.links;
  return RAW_DATA.fullAdjacency;
}

/**
 * Determines whether a node is currently visible and interactive (eligible for quadtree hit-testing).
 * @param {Object} n - Node object.
 * @returns {boolean} True if node is visible and interactive.
 */
window.isNodeInteractive = function (n) {
  if (!n || n.isDummy || String(n.id).startsWith("__dummy")) return false;
  if (n.x == null || n.y == null) return false;
  if (n.color === CONFIG.visuals.colors.Transparent) return false;
  if (n.isRogue && !VISIBILITY_STATE.Rogue && !n.isTarget) return false;
  return true;
};

/**
 * Rebuilds the spatial quadtree containing only currently visible/interactive nodes
 * so hidden or Z-Score-filtered nodes cannot be hovered, clicked, or block underlying edges.
 */
window.rebuildInteractiveQuadtree = function () {
  if (typeof d3 === "undefined") return;
  const interactiveNodes = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (window.isNodeInteractive(n)) {
      interactiveNodes.push(n);
    }
  }
  quadtree = d3
    .quadtree()
    .x((d) => d.x)
    .y((d) => d.y)
    .addAll(interactiveNodes);
};

/**
 * Applies Z-Score threshold filtering (when enabled) and target gene isolation
 * to update active graph nodes and links.
 */
window.applyEdgeFilter = function () {
  const zEnabled = typeof ZSCORE_STATE !== "undefined" && ZSCORE_STATE.enabled;
  const threshold = zEnabled ? ZSCORE_STATE.threshold : -Infinity;

  // Clear stale hover state so filtered-out edges/nodes cannot stay highlighted or clicked
  if (typeof HOVERED_EDGE !== "undefined") HOVERED_EDGE = null;
  const tooltipEl = document.getElementById("tooltip");
  if (tooltipEl) tooltipEl.style.display = "none";
  if (typeof canvas !== "undefined" && canvas && canvas.classList) {
    canvas.classList.remove("hovering");
  }

  let sourceNodes = RAW_DATA.workingNodes;
  if (!sourceNodes) {
    sourceNodes = RAW_DATA.nodes.map((n) => ({ ...n }));
    RAW_DATA.workingNodes = sourceNodes;
  }

  const sourceLinks = RAW_DATA.workingLinks || RAW_DATA.links;
  const nodeMap = new Map();
  const counts = new Map();
  for (let i = 0; i < sourceNodes.length; i++) {
    const n = sourceNodes[i];
    const idStr = String(n.id);
    nodeMap.set(idStr, n);
    counts.set(idStr, 0);
  }

  const nextLinks = [];
  for (let i = 0; i < sourceLinks.length; i++) {
    const l = sourceLinks[i];
    if (zEnabled) {
      const zVal =
        l.z_score !== undefined && l.z_score !== null && l.z_score !== ""
          ? Number(l.z_score)
          : null;
      if (zVal === null || !Number.isFinite(zVal) || zVal < threshold) continue;
    }

    const sId = String(l.source?.id || l.source);
    const tId = String(l.target?.id || l.target);
    const sNode = nodeMap.get(sId);
    const tNode = nodeMap.get(tId);
    if (!sNode || !tNode) continue;

    counts.set(sId, (counts.get(sId) || 0) + 1);
    counts.set(tId, (counts.get(tId) || 0) + 1);

    nextLinks.push({
      source: sNode,
      target: tNode,
      weight: l.weight,
      z_score: l.z_score !== undefined && l.z_score !== null ? l.z_score : null,
      sign: l.sign || null,
      has_interacts: l.has_interacts !== undefined ? l.has_interacts : true,
      has_regulates: l.has_regulates || false,
      directions: l.directions || null,
      binds: l.binds || null,
      reg_matched: l.reg_matched || false,
    });
  }
  links = nextLinks;

  const textInput = document.getElementById("target-input");
  const text = textInput ? textInput.value : "";
  const rawTargets = window.parseRawTargets
    ? window.parseRawTargets(text)
    : text.split(/[\r\n,\t]+/).map((s) => s.trim()).filter(Boolean);
  const targetSet = window.resolveTargetIds
    ? window.resolveTargetIds(rawTargets)
    : new Set(rawTargets);
  const isTargeted = targetSet.size > 0;

  const nextNodes = [];
  let hasUnplacedRogue = false;
  for (let i = 0; i < sourceNodes.length; i++) {
    const n = sourceNodes[i];
    const idStr = String(n.id);
    const deg = counts.get(idStr) || 0;
    n.deg = deg;
    if (deg > 0) {
      n.isRogue = false;
      n.dashed = false;
    } else {
      n.isRogue = true;
      n.dashed = true;
      if (n.x == null || n.y == null) hasUnplacedRogue = true;
    }
    nextNodes.push(n);
  }
  nodes = nextNodes;

  if (hasUnplacedRogue && typeof window.positionUnplacedRogueNodes === "function") {
    window.positionUnplacedRogueNodes();
  }

  if (typeof updateVisualProps === "function") updateVisualProps();

  const isZThresholdChanged =
    zEnabled && Math.abs(threshold - ZSCORE_STATE.defaultThreshold) > 1e-6;
  window.IS_FILTERED_NETWORK =
    RAW_DATA.workingLinks !== null || isTargeted || isZThresholdChanged;
  window.updateClusterAvailability();

  if (
    !zEnabled &&
    sourceLinks === RAW_DATA.links &&
    links.length === RAW_DATA.links.length &&
    RAW_DATA.fullAdjacency &&
    RAW_DATA._fullAdjacencyLinksRef === RAW_DATA.links
  ) {
    RAW_DATA.adjacency = RAW_DATA.fullAdjacency;
  } else {
    RAW_DATA.adjacency = buildAdjacency(nodes, links);
  }

  if (typeof simulation !== "undefined" && simulation) {
    simulation.nodes(nodes);
    simulation.force("link").links(links);
    if (typeof isSimRunning !== "undefined" && isSimRunning) simulation.alpha(0.3).restart();
    else simulation.stop();
  }

  if (typeof window.reapplyColors === "function") {
    window.reapplyColors();
  } else {
    if (typeof updateVisualProps === "function") updateVisualProps();
    window.rebuildInteractiveQuadtree();
    if (typeof window.updateActiveCounts === "function") window.updateActiveCounts();
    if (typeof window.updateTargetCounts === "function") window.updateTargetCounts();
    if (typeof window.draw === "function") requestAnimationFrame(window.draw);
  }
};

/**
 * Resets all cached regulatory annotations on active, working, raw, and embedded edges.
 */
window.resetAllRegulationEdges = function () {
  const clearArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (!e) continue;
      e.has_regulates = false;
      e.directions = null;
      e.reg_matched = false;
      delete e.clicked_src;
      delete e.clicked_tgt;
    }
  };
  clearArr(links);
  if (RAW_DATA) {
    clearArr(RAW_DATA.links);
    clearArr(RAW_DATA.workingLinks);
    clearArr(RAW_DATA.embeddedLinks);
  }
  if (typeof HOVERED_EDGE !== "undefined") {
    HOVERED_EDGE = null;
  }
};

/**
 * Batches and fetches promoter-binding motif regulatory directions via RICE2NET_API
 * strictly on edges connecting currently visible nodes, filtered by selected motif sources.
 * @param {Array<string>|null} sources - Selected motif database source names.
 * @param {boolean} resetPrevious - Forget previous regulation results before scanning (default true).
 * @returns {Promise<{ matchedEdgesCount: number, scannedEdgesCount: number }>}
 */
window.fetchRegulationEdges = async function (sources = null, resetPrevious = true) {
  if (resetPrevious) {
    window.resetAllRegulationEdges();
  }

  // Strictly select edges whose endpoints are currently visible on the graph
  const visibleNodeSet = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || n.isDummy || String(n.id).startsWith("__dummy")) continue;
    if (n.isRogue && !VISIBILITY_STATE.Rogue && !n.isTarget) continue;
    if (n.color === CONFIG.visuals.colors.Transparent) continue;
    visibleNodeSet.add(String(n.id));
  }

  const pendingEdges = links.filter((l) => {
    if (!resetPrevious && l.reg_matched) return false;
    const sId = String(l.source?.id || l.source);
    const tId = String(l.target?.id || l.target);
    return visibleNodeSet.has(sId) && visibleNodeSet.has(tId);
  });

  if (pendingEdges.length === 0) {
    return { matchedEdgesCount: 0, scannedEdgesCount: 0 };
  }

  const loader = document.getElementById("loader");
  const loaderText = document.getElementById("loader-text");
  const progressBar = document.getElementById("progress-bar");

  if (loader) loader.style.display = "block";
  if (progressBar) progressBar.style.width = "0%";
  if (loaderText) loaderText.innerText = "FETCHING PROMOTER-BINDING MOTIF OCCURRENCES... 0%";

  const batchSize = 500;
  const totalBatches = Math.ceil(pendingEdges.length / batchSize);

  const pendingByQueryKey = new Map();
  pendingEdges.forEach((l) => {
    const sNodeId = String(l.source?.id || l.source);
    const tNodeId = String(l.target?.id || l.target);
    const sQueryId = String(l.source?.rap_id || sNodeId);
    const tQueryId = String(l.target?.rap_id || tNodeId);
    const key = `${sQueryId}-${tQueryId}`;
    if (!pendingByQueryKey.has(key)) pendingByQueryKey.set(key, []);
    pendingByQueryKey.get(key).push({
      edge: l,
      sNodeId,
      tNodeId,
      sQueryId,
      tQueryId,
    });
  });

  const fullAdj = getFullAdjacency();
  const findRawEdge = (sId, tId) => {
    const neighbors = fullAdj.get(sId);
    if (!neighbors || !RAW_DATA.links) return null;
    for (let i = 0; i < neighbors.length; i++) {
      if (neighbors[i].n === tId) {
        return RAW_DATA.links[neighbors[i].idx] || null;
      }
    }
    return null;
  };

  let matchedEdgesCount = 0;

  try {
    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, pendingEdges.length);
      const batch = pendingEdges.slice(start, end);

      const pairs = batch.map((l) => ({
        s: String(l.source?.rap_id || l.source?.id || l.source),
        t: String(l.target?.rap_id || l.target?.id || l.target),
      }));

      const data = await window.RICE2NET_API.checkRegulates(pairs, sources);

      (data.edges || []).forEach((e) => {
        const key = `${e.original_s}-${e.original_t}`;
        const matches = pendingByQueryKey.get(key);
        if (!matches) return;

        matches.forEach(({ edge, sNodeId, tNodeId, sQueryId, tQueryId }) => {
          const mappedDirs = (e.directions || []).map((d) => {
            let src = d.src;
            let tgt = d.tgt;
            if (d.src === sQueryId && d.tgt === tQueryId) {
              src = sNodeId;
              tgt = tNodeId;
            } else if (d.src === tQueryId && d.tgt === sQueryId) {
              src = tNodeId;
              tgt = sNodeId;
            }
            return { src, tgt };
          });

          const hasReg = mappedDirs.length > 0;
          if (hasReg && !edge.has_regulates) matchedEdgesCount++;
          edge.has_regulates = hasReg;
          edge.directions = mappedDirs;

          const rawEdge = findRawEdge(sNodeId, tNodeId);
          if (rawEdge && rawEdge !== edge) {
            rawEdge.has_regulates = hasReg;
            rawEdge.directions = mappedDirs;
          }
        });
      });

      batch.forEach((l) => {
        l.reg_matched = true;
        const sId = String(l.source?.id || l.source);
        const tId = String(l.target?.id || l.target);
        const rawEdge = findRawEdge(sId, tId);
        if (rawEdge) rawEdge.reg_matched = true;
      });

      if (loaderText && progressBar) {
        const pct = Math.round(((i + 1) / totalBatches) * 100);
        loaderText.innerText = `FETCHING PROMOTER-BINDING MOTIF OCCURRENCES... ${pct}%`;
        progressBar.style.width = `${pct}%`;
      }

      if (totalBatches > 1) {
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    if (typeof window.draw === "function") requestAnimationFrame(window.draw);
    return { matchedEdgesCount, scannedEdgesCount: pendingEdges.length };
  } catch (e) {
    throw new Error(`Promoter-binding motif search failed: ${e.message}`);
  } finally {
    if (loader) loader.style.display = "none";
  }
};

/**
 * Loads precomputed global functional cluster definitions, colors, and ORA terms via RICE2NET_API.
 */
async function loadClusters() {
  CLUSTER_STATE.active.clear();
  CLUSTER_STATE.legend = [];
  CLUSTER_STATE.data.clear();
  if (CLUSTER_STATE.byId) CLUSTER_STATE.byId.clear();
  CLUSTER_STATE.source = null;
  CLUSTER_STATE.lastStats = null;

  if (!window.CLUSTERS_ENABLED) {
    window.updateClusterAvailability();
    return;
  }

  const loaderText = document.getElementById("loader-text");
  if (loaderText) loaderText.innerText = "LOADING CLUSTERS...";

  try {
    const data = await window.RICE2NET_API.getClusters();
    if (data && Array.isArray(data.clusters) && data.clusters.length > 0) {
      CLUSTER_STATE.source = "db";
      const meta = data.meta || {};
      CLUSTER_STATE.lastStats = {
        totalModulesDetected: data.clusters.length,
        enrichedClustersCount: data.clusters.length,
        markovTime: meta.markovTime ?? 1.5,
        pvalThreshold: meta.pvalThreshold ?? 0.05,
        background: {
          mode: meta.backgroundMode || "network",
          annotatedOnly: meta.annotatedOnly !== false,
          rawBackgroundSize: (RAW_DATA && RAW_DATA.nodes ? RAW_DATA.nodes.length : nodes.length) || 0,
        },
      };

      data.clusters.forEach((cluster, index) => {
        const id = String(cluster.id || `db_${index + 1}`);
        const name = cluster.name;
        const hasSavedColor = Boolean(cluster.color);
        const color =
          cluster.color ||
          CONFIG.visuals.colors.Clusters[index % CONFIG.visuals.colors.Clusters.length];
        const geneList = Array.isArray(cluster.genes) ? cluster.genes.map(String) : [];
        const termList = Array.isArray(cluster.terms) ? cluster.terms : [];

        const entry = {
          id,
          name,
          color,
          customColor: hasSavedColor,
          count: geneList.length,
          genes: geneList,
          topTerm: cluster.topTerm || (termList.length > 0 ? termList[0] : null),
          termsCount: cluster.termsCount ?? termList.length,
          terms: termList,
        };
        CLUSTER_STATE.active.add(id);
        CLUSTER_STATE.legend.push(entry);
        if (CLUSTER_STATE.byId) CLUSTER_STATE.byId.set(id, entry);

        geneList.forEach((geneId) => {
          CLUSTER_STATE.data.set(geneId, id);
        });
      });

      if (typeof window.updateCommunityDiscoverySummary === "function") {
        window.updateCommunityDiscoverySummary();
      }
    }
  } catch (e) {
    console.error("Cluster API load failed:", e);
  }

  window.updateClusterAvailability();
}

/**
 * Hydrates local node metadata from database nodes mapping.
 */
async function hydrateMetadata() {
  const loaderText = document.getElementById("loader-text");
  if (loaderText) loaderText.innerText = "APPLYING METADATA...";
  await new Promise(r => setTimeout(r, 50));

  const normKey = (s) => String(s || "").trim().toLowerCase();
  const normMsu = (s) => normKey(s).replace(/^loc_/, "").replace(/\.\d+$/, "");
  const normRap = (s) => normKey(s).replace(/^(os\d{2})t(\d{7})(-\d+)?$/, "$1g$2");

  const dbMap = new Map();
  if (RAW_DATA.dbNodes) {
    RAW_DATA.dbNodes.forEach(n => {
      const idKey = normKey(n.id);
      if (idKey) dbMap.set(idKey, n);
      if (n.msu_id && n.msu_id !== ".") {
        String(n.msu_id).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean).forEach(part => {
          const pk = normKey(part);
          if (pk) dbMap.set(pk, n);
          const noIso = pk.replace(/\.\d+$/, "");
          if (noIso) dbMap.set(noIso, n);
          const stripped = normMsu(part);
          if (stripped) dbMap.set(stripped, n);
        });
      }
      if (n.identifier && n.identifier !== ".") {
        const ik = normKey(n.identifier);
        if (ik && !dbMap.has(ik)) dbMap.set(ik, n);
      }
      if (n.symbol && n.symbol !== ".") {
        const sk = normKey(n.symbol);
        if (sk && !dbMap.has(sk)) dbMap.set(sk, n);
      }
    });
  }

  const lookupDb = (val) => {
    if (!val || val === ".") return null;
    const k = normKey(val);
    if (dbMap.has(k)) return dbMap.get(k);
    const rk = normRap(val);
    if (dbMap.has(rk)) return dbMap.get(rk);
    const mk = normMsu(val);
    if (dbMap.has(mk)) return dbMap.get(mk);
    return null;
  };

  nodes.forEach((n) => {
    n.metadata = n.metadata || {};
    n.tfDetail = n.tfDetail || [];
    n.keggDetail = n.keggDetail || [];
    n.symbol = n.symbol || "";
    n.originalType = n.originalType || "Gene";

    const dbInfo = lookupDb(n.id) || lookupDb(n.rap_id) || lookupDb(n.msu_id) || lookupDb(n.identifier);
    if (dbInfo) {
      n.originalType = dbInfo.originalType || n.originalType;
      n.symbol = dbInfo.symbol || n.symbol;
      if (dbInfo.id) {
        n.rap_id = n.rap_id || dbInfo.id;
        n.metadata["RAP_ID"] = dbInfo.id;
      }
      if (dbInfo.msu_id) {
        n.msu_id = n.msu_id || dbInfo.msu_id;
        n.metadata["MSU_ID"] = dbInfo.msu_id;
      }
      if (dbInfo.identifier) {
        n.identifier = n.identifier || dbInfo.identifier;
        n.metadata["Identifier"] = dbInfo.identifier;
      }
    }

    if (n.rap_id) n.metadata["RAP_ID"] = n.rap_id;
    if (n.identifier) n.metadata["Identifier"] = n.identifier;
    if (n.msu_id) n.metadata["MSU_ID"] = n.msu_id;

    if (window.applyNodeTypeStyling) window.applyNodeTypeStyling(n);
  });
}

/**
 * Caches a metadata snapshot for all active nodes.
 */
function cacheMetaSnapshot() {
  RAW_DATA.metaById = new Map(
    nodes.map((n) => [
      String(n.id),
      {
        originalType: n.originalType || "Gene",
        symbol: n.symbol || "",
        rap_id: n.rap_id || (n.metadata && n.metadata.RAP_ID) || "",
        identifier: n.identifier || (n.metadata && n.metadata.Identifier) || "",
        msu_id: n.msu_id || (n.metadata && n.metadata.MSU_ID) || "",
        metadata: n.metadata ? { ...n.metadata } : {},
        tfDetail: Array.isArray(n.tfDetail) ? n.tfDetail.map((x) => ({ ...x })) : [],
        keggDetail: Array.isArray(n.keggDetail) ? n.keggDetail.map((x) => ({ ...x })) : [],
      },
    ]),
  );
}

/** Fallback node type styling function */
window.applyTypeStyling = window.applyTypeStyling || function (n) {
  if (n.originalType === "TF") {
    n.color = CONFIG?.visuals?.colors?.TF || "#d62728";
    n.shape = "diamond";
    n.typeLabel = "Transcription Factor";
  } else if (n.originalType === "Predicted TF") {
    n.color = CONFIG?.visuals?.colors?.Predicted || "#ff7f0e";
    n.shape = "diamond";
    n.typeLabel = "Predicted TF";
  } else if (n.originalType === "Predicted TR") {
    n.color = CONFIG?.visuals?.colors?.Predicted || "#ff7f0e";
    n.shape = "diamond";
    n.hollow = true;
    n.typeLabel = "Predicted TR";
  } else if (n.originalType === "Annotated Gene") {
    n.color = CONFIG?.visuals?.colors?.AnnotatedGene || "#2ca02c";
    n.shape = "circle";
    n.typeLabel = "Annotated Gene";
  } else {
    n.color = CONFIG?.visuals?.colors?.Gene || "#1f77b4";
    n.shape = "circle";
    n.typeLabel = "Gene";
  }
};

/**
 * Primary entry point for fetching network topology and starting application setup.
 */
async function main() {
  const loader = document.getElementById("loader");
  const loaderText = document.getElementById("loader-text");
  const progressBar = document.getElementById("progress-bar");

  if (document.body && document.body.classList) document.body.classList.add("is-loading");
  if (loader) loader.style.display = "block";
  if (loaderText) loaderText.innerText = "FETCHING NETWORK TOPOLOGY...";
  if (progressBar) progressBar.style.width = "10%";
  await new Promise(r => setTimeout(r, 50));

  try {
    const graphData = await window.RICE2NET_API.initNetwork();

    // Keep single immutable baseline references (avoid cloning ~885k edges on startup)
    RAW_DATA.embeddedNodes = graphData.nodes || [];
    RAW_DATA.embeddedLinks = graphData.edges || [];
    RAW_DATA.dbNodes = RAW_DATA.embeddedNodes;
    RAW_DATA.nodes = RAW_DATA.embeddedNodes;
    RAW_DATA.links = RAW_DATA.embeddedLinks;

    nodes = RAW_DATA.nodes.map((n) => ({
      ...n,
      _hasLayoutPos: n.x !== null && n.x !== undefined && n.y !== null && n.y !== undefined,
    }));
    RAW_DATA.workingNodes = nodes;
    RAW_DATA.workingLinks = null;

    window.IS_IMPORTED_NETWORK = false;
    window.IS_FILTERED_NETWORK = false;
    window.CLUSTERS_ENABLED = true;

    if (window.CLUSTERS_ENABLED && typeof loadClusters === "function") {
        if (loaderText) loaderText.innerText = "LOADING CLUSTERS...";
        if (progressBar) progressBar.style.width = "40%";
        await loadClusters();
    } else if (typeof window.updateClusterAvailability === "function") {
        window.updateClusterAvailability();
    }

    if (loaderText) loaderText.innerText = "PREPARING NETWORK METADATA...";
    if (progressBar) progressBar.style.width = "70%";

    nodes.forEach((n) => {
      n.metadata = {};
      n.keggDetail = [];
      n.tfDetail = [];
      n.originalType = n.originalType || "Gene";
      n.identifier = n.identifier || "";

      if (n.msu_id) n.metadata["MSU_ID"] = n.msu_id;
      if (n.identifier) n.metadata["Identifier"] = n.identifier;

      if (window.applyNodeTypeStyling) window.applyNodeTypeStyling(n);
    });

    if (typeof cacheMetaSnapshot === "function") cacheMetaSnapshot();

    // Configure dynamic Z-Score filter bounds (default 1.28 when present, hidden when absent).
    // When Z-Score filtering is enabled, applyEdgeFilter() materializes only edges >= defaultThreshold
    // directly from RAW_DATA.links, avoiding redundant multi-million-edge allocations on startup.
    RAW_DATA.fullAdjacency = null;
    RAW_DATA._fullAdjacencyLinksRef = null;

    const hasZScore =
      typeof window.configureZScoreBounds === "function"
        ? window.configureZScoreBounds(RAW_DATA.links)
        : false;

    if (hasZScore && typeof window.applyEdgeFilter === "function") {
      links = [];
      window.applyEdgeFilter();
    } else {
      const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
      links = RAW_DATA.links
        .map((e) => ({
          source: nodeMap.get(String(e.source?.id || e.source)),
          target: nodeMap.get(String(e.target?.id || e.target)),
          weight:
            e.weight !== undefined && e.weight !== null
              ? e.weight
              : e.value !== undefined && e.value !== null
              ? e.value
              : 1,
          z_score: e.z_score !== undefined && e.z_score !== null ? e.z_score : null,
          sign: e.sign || null,
          has_interacts: e.has_interacts !== undefined ? e.has_interacts : true,
          has_regulates: e.has_regulates || false,
          directions: e.directions || null,
          binds: e.binds || null,
          reg_matched: !!e.reg_matched,
        }))
        .filter((l) => l.source && l.target);

      RAW_DATA.adjacency = buildAdjacency(nodes, links);
      RAW_DATA.fullAdjacency = RAW_DATA.adjacency;
      RAW_DATA._fullAdjacencyLinksRef = RAW_DATA.links;
    }

    if (nodes.length > 0 && nodes.some((n) => n.x !== undefined && n.x !== null)) {
      if (loaderText) loaderText.innerText = "RENDERING...";
      if (progressBar) progressBar.style.width = "100%";
      if (typeof finishSetup === "function") finishSetup(true);
      if (loader) loader.style.display = "none";
      if (document.body && document.body.classList) document.body.classList.remove("is-loading");
    } else {
      if (loaderText) loaderText.innerText = "INITIALIZING LAYOUT SIMULATION...";
      if (progressBar) progressBar.style.width = "100%";
      await new Promise(r => setTimeout(r, 50));
      if (document.body && document.body.classList) document.body.classList.remove("is-loading");
      if (typeof startCalculation === "function") startCalculation(true);
    }
  } catch (error) {
    console.error("Failed to fetch initial network.", error);
    if (loaderText) loaderText.innerText = "Unable to connect to the Rice2Net server.";
    if (document.body && document.body.classList) document.body.classList.remove("is-loading");
  }
}

/**
 * In-memory reversion to the embedded database network without browser page reloads.
 * Immediately clears the canvas, locks interaction, and renders progress popup stages.
 */
window.revertToEmbeddedNetworkCore = async function () {
  const nextPaint = () => new Promise((r) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(r, 30));
    } else {
      setTimeout(r, 30);
    }
  });

  // 1. Immediately clear import UI, overlays, filters, and active selection state
  const jsonInfo = document.getElementById("import-json-info");
  if (jsonInfo) jsonInfo.style.display = "none";
  const edgesInfo = document.getElementById("import-edges-info");
  if (edgesInfo) edgesInfo.style.display = "none";
  const jsonFile = document.getElementById("import-json-file");
  if (jsonFile) jsonFile.value = "";
  const edgesFile = document.getElementById("import-edges-file");
  if (edgesFile) edgesFile.value = "";

  const targetInput = document.getElementById("target-input");
  if (targetInput) targetInput.value = "";
  const targetFile = document.getElementById("target-file");
  if (targetFile) targetFile.value = "";
  if (typeof window.closeDetails === "function") window.closeDetails();

  const tooltipEl = document.getElementById("tooltip");
  if (tooltipEl) tooltipEl.style.display = "none";
  const ctxMenu = document.getElementById("context-menu");
  if (ctxMenu) ctxMenu.style.display = "none";
  if (typeof window.hideDemoImportNotice === "function") window.hideDemoImportNotice();

  if (typeof simulation !== "undefined" && simulation) simulation.stop();

  window.IS_IMPORTED_NETWORK = false;
  window.IS_FILTERED_NETWORK = false;
  // Always reset any in-memory clusters and promoter-binding motif overlays when reverting to the embedded network
  if (typeof window.resetClustersState === "function") {
    window.resetClustersState();
  } else if (typeof window.clearDiscoveredClusters === "function") {
    window.clearDiscoveredClusters();
  }
  if (typeof window.clearPromoterMotifAnalysis === "function") {
    window.clearPromoterMotifAnalysis(true);
  } else {
    if (typeof window.resetAllRegulationEdges === "function") window.resetAllRegulationEdges();
    if (typeof window.REGULATION_STATE !== "undefined") {
      window.REGULATION_STATE.isAvailable = false;
      window.REGULATION_STATE.sources = [];
      window.REGULATION_STATE.edgeCount = 0;
    }
  }
  if (typeof VISIBILITY_STATE !== "undefined") {
    VISIBILITY_STATE.EdgeBoth = 0;
    VISIBILITY_STATE.Rogue = 0;
  }
  if (typeof enterApp === "function") enterApp();

  // 2. Immediately clear canvas & disable interaction before doing any work
  nodes = [];
  links = [];
  if (typeof quadtree !== "undefined") quadtree = null;
  if (typeof HOVERED_NODE !== "undefined") HOVERED_NODE = null;
  if (typeof HOVERED_EDGE !== "undefined") HOVERED_EDGE = null;
  if (typeof SELECTED_NODE !== "undefined") SELECTED_NODE = null;

  const valNodes = document.getElementById("val-nodes");
  const valEdges = document.getElementById("val-edges");
  const valTargets = document.getElementById("val-targets");
  if (valNodes) valNodes.innerText = "-";
  if (valEdges) valEdges.innerText = "-";
  if (valTargets) valTargets.style.display = "none";

  if (typeof window.draw === "function") window.draw();

  const loader = document.getElementById("loader");
  const loaderText = document.getElementById("loader-text");
  const progressBar = document.getElementById("progress-bar");

  if (document.body && document.body.classList) document.body.classList.add("is-loading");
  if (loader) loader.style.display = "block";
  if (loaderText) loaderText.innerText = "CLEARING WORKSPACE...";
  if (progressBar) progressBar.style.width = "10%";
  await nextPaint();

  try {
    if (
      RAW_DATA &&
      Array.isArray(RAW_DATA.embeddedNodes) &&
      RAW_DATA.embeddedNodes.length > 0 &&
      Array.isArray(RAW_DATA.embeddedLinks)
    ) {
      if (loaderText) loaderText.innerText = "RESTORING REFERENCE NETWORK...";
      if (progressBar) progressBar.style.width = "30%";
      await nextPaint();

      RAW_DATA.nodes = RAW_DATA.embeddedNodes;
      RAW_DATA.links = RAW_DATA.embeddedLinks;
      RAW_DATA.dbNodes = RAW_DATA.embeddedNodes;

      nodes = RAW_DATA.nodes.map((n) => ({
      ...n,
      _hasLayoutPos: n.x !== null && n.x !== undefined && n.y !== null && n.y !== undefined,
    }));
      RAW_DATA.workingNodes = nodes;
      RAW_DATA.workingLinks = null;

      window.CLUSTERS_ENABLED = true;
      if (window.CLUSTERS_ENABLED && typeof loadClusters === "function") {
        if (loaderText) loaderText.innerText = "LOADING CLUSTERS...";
        if (progressBar) progressBar.style.width = "55%";
        await nextPaint();
        await loadClusters();
      } else if (typeof window.updateClusterAvailability === "function") {
        window.updateClusterAvailability();
      }

      if (loaderText) loaderText.innerText = "PREPARING NETWORK METADATA...";
      if (progressBar) progressBar.style.width = "75%";
      await nextPaint();

      nodes.forEach((n) => {
        n.metadata = {};
        n.keggDetail = [];
        n.tfDetail = [];
        n.originalType = n.originalType || "Gene";
        n.identifier = n.identifier || "";

        if (n.msu_id) n.metadata["MSU_ID"] = n.msu_id;
        if (n.identifier) n.metadata["Identifier"] = n.identifier;

        if (window.applyNodeTypeStyling) window.applyNodeTypeStyling(n);
      });

      if (typeof cacheMetaSnapshot === "function") cacheMetaSnapshot();

      RAW_DATA.fullAdjacency = null;
      RAW_DATA._fullAdjacencyLinksRef = null;

      const hasZScore =
        typeof window.configureZScoreBounds === "function"
          ? window.configureZScoreBounds(RAW_DATA.links)
          : false;

      if (hasZScore && typeof window.applyEdgeFilter === "function") {
        links = [];
        window.applyEdgeFilter();
      } else {
        const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
        links = RAW_DATA.links
          .map((e) => ({
            source: nodeMap.get(String(e.source?.id || e.source)),
            target: nodeMap.get(String(e.target?.id || e.target)),
            weight:
              e.weight !== undefined && e.weight !== null
                ? e.weight
                : e.value !== undefined && e.value !== null
                ? e.value
                : 1,
            z_score: e.z_score !== undefined && e.z_score !== null ? e.z_score : null,
            sign: e.sign || null,
            has_interacts: e.has_interacts !== undefined ? e.has_interacts : true,
            has_regulates: e.has_regulates || false,
            directions: e.directions || null,
            binds: e.binds || null,
            reg_matched: !!e.reg_matched,
          }))
          .filter((l) => l.source && l.target);

        RAW_DATA.adjacency = buildAdjacency(nodes, links);
        RAW_DATA.fullAdjacency = RAW_DATA.adjacency;
        RAW_DATA._fullAdjacencyLinksRef = RAW_DATA.links;
      }

      if (typeof updateClusterAvailability === "function") updateClusterAvailability();

      if (loaderText) loaderText.innerText = "RENDERING GLOBAL NETWORK...";
      if (progressBar) progressBar.style.width = "95%";
      await nextPaint();

      if (typeof finishSetup === "function") finishSetup(true);
      if (typeof window.reapplyColors === "function") window.reapplyColors();
      if (typeof window.autoFit === "function") window.autoFit();

      if (progressBar) progressBar.style.width = "100%";
      await nextPaint();
    } else if (typeof main === "function") {
      await main();
    }
  } finally {
    if (loader) loader.style.display = "none";
    if (document.body && document.body.classList) document.body.classList.remove("is-loading");
  }
};

window.__APP_CORE__.main = main;
window.__APP_CORE__.hydrateMetadata = hydrateMetadata;
window.__APP_CORE__.buildAdjacency = buildAdjacency;
window.__APP_CORE__.getFullAdjacency = getFullAdjacency;
window.__APP_CORE__.cacheMetaSnapshot = cacheMetaSnapshot;
window.__APP_CORE__.revertToEmbeddedNetworkCore = window.revertToEmbeddedNetworkCore;
