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
 * Applies IRP threshold filtering and target gene isolation to update active graph nodes and links.
 */
window.applyEdgeFilter = function () {
  const threshold = IRP_STATE.threshold;

  let sourceNodes = RAW_DATA.workingNodes;
  if (!sourceNodes) {
    sourceNodes = RAW_DATA.nodes.map((n) => ({ ...n }));
    RAW_DATA.workingNodes = sourceNodes;
  }

  const sourceLinks = RAW_DATA.workingLinks || RAW_DATA.links;
  const nodeMap = new Map(sourceNodes.map((n) => [String(n.id), n]));

  links = sourceLinks
    .filter((l) => {
      const score = l.irp !== undefined && l.irp !== null ? l.irp : 0;
      if (score < threshold) return false;

      const sId = String(l.source?.id || l.source);
      const tId = String(l.target?.id || l.target);
      return nodeMap.has(sId) && nodeMap.has(tId);
    })
    .map((l) => ({
      source: nodeMap.get(String(l.source?.id || l.source)),
      target: nodeMap.get(String(l.target?.id || l.target)),
      weight: l.weight,
      irp: l.irp,
      has_interacts: l.has_interacts !== undefined ? l.has_interacts : true,
      has_regulates: l.has_regulates || false,
      directions: l.directions || null,
      reg_matched: l.reg_matched || false
    }));

  const counts = new Map();
  sourceNodes.forEach((n) => counts.set(String(n.id), 0));
  links.forEach((l) => {
    const sId = String(l.source.id);
    const tId = String(l.target.id);
    counts.set(sId, (counts.get(sId) || 0) + 1);
    counts.set(tId, (counts.get(tId) || 0) + 1);
  });

  const textInput = document.getElementById("target-input");
  const text = textInput ? textInput.value : "";
  const rawTargets = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const targetSet = window.resolveTargetIds
    ? window.resolveTargetIds(rawTargets)
    : new Set(rawTargets);
  const isTargeted = targetSet.size > 0;

  nodes = sourceNodes.filter((n) => {
    const deg = counts.get(String(n.id)) || 0;
    if (deg > 0) {
      n.isRogue = false;
      return true;
    }
    if (!isTargeted) {
      n.isRogue = true;
      return true;
    } else if (targetSet.has(String(n.id))) {
      n.isRogue = true;
      return true;
    }
    return false;
  });

  window.IS_FILTERED_NETWORK = (nodes.length < RAW_DATA.nodes.length) || isTargeted || threshold > 0;
  window.updateClusterAvailability();

  RAW_DATA.adjacency = buildAdjacency(nodes, links);

  if (typeof simulation !== "undefined" && simulation) {
    simulation.nodes(nodes);
    simulation.force("link").links(links);
    if (typeof isSimRunning !== "undefined" && isSimRunning) simulation.alpha(0.3).restart();
    else simulation.stop();
  }

  if (typeof d3 !== "undefined") {
    quadtree = d3
      .quadtree()
      .x((d) => d.x)
      .y((d) => d.y)
      .addAll(nodes);
  }

  if (typeof window.updateActiveCounts === "function") window.updateActiveCounts();
  if (typeof window.updateTargetCounts === "function") window.updateTargetCounts();

  if (typeof window.draw === "function") requestAnimationFrame(window.draw);
};

/**
 * Batches and fetches regulation relationship directions from the Neo4j API endpoint.
 */
window.fetchRegulationEdges = async function () {
  const pendingEdges = links.filter((l) => !l.reg_matched);
  if (pendingEdges.length === 0) {
    return;
  }

  const loader = document.getElementById("loader");
  const loaderText = document.getElementById("loader-text");
  const progressBar = document.getElementById("progress-bar");

  if (loader) loader.style.display = "block";
  if (progressBar) progressBar.style.width = "0%";
  if (loaderText) loaderText.innerText = "FETCHING REGULATION DATA... 0%";

  const batchSize = 500;
  const totalBatches = Math.ceil(pendingEdges.length / batchSize);

  const edgeMap = new Map();
  links.forEach((l) => {
    const key = `${l.source.id || l.source}-${l.target.id || l.target}`;
    edgeMap.set(key, l);
  });

  const sourceEdgeMap = new Map();
  if (RAW_DATA && RAW_DATA.links) {
    RAW_DATA.links.forEach((l) => {
      const sId = String(l.source?.id || l.source);
      const tId = String(l.target?.id || l.target);
      sourceEdgeMap.set(`${sId}-${tId}`, l);
      sourceEdgeMap.set(`${tId}-${sId}`, l);
    });
  }

  try {
    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, pendingEdges.length);
      const batch = pendingEdges.slice(start, end);

      const pairs = batch.map((l) => ({
        s: String(l.source.id || l.source),
        t: String(l.target.id || l.target),
      }));

      const response = await fetch(
        "http://localhost:3000/api/network/edges/regulates",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairs }),
        }
      );

      if (!response.ok) throw new Error(`Batch ${i + 1} failed`);

      const data = await response.json();

      data.edges.forEach((e) => {
        const key = `${e.original_s}-${e.original_t}`;

        if (edgeMap.has(key)) {
          const edge = edgeMap.get(key);
          edge.has_regulates = e.directions && e.directions.length > 0;
          edge.directions = e.directions;
        }

        if (sourceEdgeMap.has(key)) {
          const rawEdge = sourceEdgeMap.get(key);
          rawEdge.has_regulates = e.directions && e.directions.length > 0;
          rawEdge.directions = e.directions;
        }
      });

      batch.forEach((l) => {
        l.reg_matched = true;
        const sId = String(l.source.id || l.source);
        const tId = String(l.target.id || l.target);
        if (sourceEdgeMap.has(`${sId}-${tId}`)) sourceEdgeMap.get(`${sId}-${tId}`).reg_matched = true;
      });

      if (loaderText && progressBar) {
        const pct = Math.round(((i + 1) / totalBatches) * 100);
        loaderText.innerText = `FETCHING REGULATION DATA... ${pct}%`;
        progressBar.style.width = `${pct}%`;
      }

      await new Promise((r) => setTimeout(r, 30));
    }

    if (typeof window.draw === "function") requestAnimationFrame(window.draw);

  } catch (e) {
    alert(`Regulation data request failed: ${e.message}`);
  } finally {
    if (loader) loader.style.display = "none";
  }
};

/**
 * Loads functional cluster definitions and gene assignments from the backend API.
 */
async function loadClusters() {
  const loaderText = document.getElementById("loader-text");
  if (loaderText) loaderText.innerText = "LOADING CLUSTERS FROM DB...";

  CLUSTER_STATE.active.clear();
  CLUSTER_STATE.legend = [];
  CLUSTER_STATE.data.clear();

  try {
    const response = await fetch("http://localhost:3000/api/network/clusters");
    if (!response.ok) throw new Error("Failed to fetch clusters from API");

    const data = await response.json();
    if (data && data.clusters) {
      data.clusters.forEach((cluster, index) => {
        const name = cluster.name;
        const color = CONFIG.visuals.colors.Clusters[index % CONFIG.visuals.colors.Clusters.length];

        CLUSTER_STATE.active.add(name);
        CLUSTER_STATE.legend.push({ name, color, count: cluster.genes.length });

        cluster.genes.forEach(geneId => {
          CLUSTER_STATE.data.set(String(geneId), name);
        });
      });
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

  const dbMap = new Map();
  if (RAW_DATA.dbNodes) {
    RAW_DATA.dbNodes.forEach(n => {
      dbMap.set(String(n.id), n);
      if (n.msu_id) dbMap.set(String(n.msu_id).replace(/\.\d+$/, ""), n);
      if (n.identifier) dbMap.set(String(n.identifier), n);
      if (n.symbol && n.symbol !== ".") dbMap.set(String(n.symbol), n);
    });
  }

  nodes.forEach((n) => {
    n.metadata = n.metadata || {};
    n.tfDetail = n.tfDetail || [];
    n.keggDetail = n.keggDetail || [];
    n.symbol = n.symbol || "";
    n.originalType = n.originalType || "Gene";

    const stringId = String(n.id);
    if (dbMap.has(stringId)) {
      const dbInfo = dbMap.get(stringId);
      n.originalType = dbInfo.originalType || n.originalType;
      n.symbol = dbInfo.symbol || n.symbol;
      if (dbInfo.msu_id) n.metadata["MSU_ID"] = dbInfo.msu_id;
      if (dbInfo.identifier) {
        n.identifier = dbInfo.identifier;
        n.metadata["Identifier"] = dbInfo.identifier;
      }
    }

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

  if (loaderText) loaderText.innerText = "FETCHING LIGHTWEIGHT TOPOLOGY...";
  if (progressBar) progressBar.style.width = "10%";
  await new Promise(r => setTimeout(r, 50));

  try {
    const response = await fetch("http://localhost:3000/api/network/init");
    if (!response.ok) throw new Error("API connection failed");

    const graphData = await response.json();

    RAW_DATA.dbNodes = graphData.nodes.map(n => ({...n}));
    RAW_DATA.dbLinks = graphData.edges.map(e => ({...e}));
    RAW_DATA.nodes = graphData.nodes || [];
    RAW_DATA.links = graphData.edges || [];

    nodes = RAW_DATA.nodes.map((n) => ({ ...n }));
    RAW_DATA.workingNodes = nodes;
    RAW_DATA.workingLinks = null;

    window.IS_IMPORTED_NETWORK = false;
    window.IS_FILTERED_NETWORK = false;

    if (typeof loadClusters === "function") {
        if (loaderText) loaderText.innerText = "FETCHING CLUSTERS...";
        if (progressBar) progressBar.style.width = "40%";
        await loadClusters();
    }

    if (loaderText) loaderText.innerText = "PREPARING METADATA...";
    if (progressBar) progressBar.style.width = "70%";

    nodes.forEach((n) => {
      n.metadata = {};
      n.keggDetail = [];
      n.tfDetail = [];
      n.originalType = n.originalType || "Gene";

      if (n.msu_id) n.metadata["MSU_ID"] = n.msu_id;

      if (window.applyNodeTypeStyling) window.applyNodeTypeStyling(n);
    });

    if (typeof cacheMetaSnapshot === "function") cacheMetaSnapshot();

    const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
    links = RAW_DATA.links
      .map((e) => ({
        source: nodeMap.get(String(e.source?.id || e.source)),
        target: nodeMap.get(String(e.target?.id || e.target)),
        weight: e.weight || e.value || 1,
        irp: e.irp,
        has_interacts: e.has_interacts !== undefined ? e.has_interacts : true,
        has_regulates: e.has_regulates || false,
        reg_matched: false
      }))
      .filter((l) => l.source && l.target);

    RAW_DATA.adjacency = buildAdjacency(nodes, links);

    if (nodes.length > 0 && nodes.some((n) => n.x !== undefined && n.x !== null)) {
      if (loaderText) loaderText.innerText = "RENDERING...";
      if (progressBar) progressBar.style.width = "100%";
      loader.style.display = "none";
      if (typeof finishSetup === "function") finishSetup(true);
    } else {
      if (loaderText) loaderText.innerText = "PREPARING PHYSICS...";
      if (progressBar) progressBar.style.width = "100%";
      await new Promise(r => setTimeout(r, 50));
      if (typeof startCalculation === "function") startCalculation(true);
    }
  } catch (error) {
    console.error("Failed to fetch from Neo4j API.", error);
    if (loaderText) loaderText.innerText = "Error: Database connection failed";
  }
}

window.__APP_CORE__.main = main;
window.__APP_CORE__.hydrateMetadata = hydrateMetadata;
window.__APP_CORE__.buildAdjacency = buildAdjacency;
window.__APP_CORE__.cacheMetaSnapshot = cacheMetaSnapshot;
