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
      irp: l.irp !== undefined && l.irp !== null ? l.irp : null,
      sign: l.sign || null,
      has_interacts: l.has_interacts !== undefined ? l.has_interacts : true,
      has_regulates: l.has_regulates || false,
      directions: l.directions || null,
      binds: l.binds || null,
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
  const rawTargets = window.parseRawTargets
    ? window.parseRawTargets(text)
    : text.split(/[\r\n,\t]+/).map((s) => s.trim()).filter(Boolean);
  const targetSet = window.resolveTargetIds
    ? window.resolveTargetIds(rawTargets)
    : new Set(rawTargets);
  const isTargeted = targetSet.size > 0;

  nodes = sourceNodes.filter((n) => {
    const deg = counts.get(String(n.id)) || 0;
    n.deg = deg;
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

  if (typeof updateVisualProps === "function") updateVisualProps();

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
  if (window.IS_IMPORTED_NETWORK) {
    return;
  }
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
        `${typeof API_BASE !== "undefined" ? API_BASE : ""}/api/network/edges/regulates`,
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

    // Fetch supporting binding events for all visible regulation edges
    const regEdges = links.filter((l) => l.has_regulates && (!l.binds || l.binds.length === 0));
    if (regEdges.length > 0) {
      if (loaderText) loaderText.innerText = "FETCHING BINDING EVIDENCE...";
      await window.fetchBindsForEdges(regEdges);
    }

    if (typeof window.draw === "function") requestAnimationFrame(window.draw);

  } catch (e) {
    alert(`Regulation data request failed: ${e.message}`);
  } finally {
    if (loader) loader.style.display = "none";
  }
};

/**
 * Fetches motif binding events supporting regulation relations for an array of edges.
 * @param {Array<Object>} edgesToFetch - Edge link objects with has_regulates = true.
 */
window.fetchBindsForEdges = async function (edgesToFetch) {
  if (!edgesToFetch || edgesToFetch.length === 0) return;

  const pairsToQuery = [];
  const pairMap = new Map();

  edgesToFetch.forEach((edge) => {
    if (!edge.has_regulates || !Array.isArray(edge.directions)) return;
    edge.directions.forEach((dir) => {
      if (!dir.src || !dir.tgt) return;
      const key = `${dir.src}->${dir.tgt}`;
      if (!pairMap.has(key)) {
        pairMap.set(key, []);
        pairsToQuery.push({ source: dir.src, target: dir.tgt });
      }
      pairMap.get(key).push({ edge, dir });
    });
  });

  if (pairsToQuery.length === 0) return;

  const apiBase = typeof API_BASE !== "undefined" ? API_BASE : "";
  const batchSize = 100;

  for (let i = 0; i < pairsToQuery.length; i += batchSize) {
    const batch = pairsToQuery.slice(i, i + batchSize);
    try {
      const response = await fetch(`${apiBase}/api/network/edges/binds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: batch }),
      });

      if (response.ok) {
        const data = await response.json();
        const bindsByPair = data.bindsByPair || {};

        batch.forEach((pair) => {
          const key = `${pair.source}->${pair.target}`;
          const binds = bindsByPair[key] || [];
          const targets = pairMap.get(key) || [];
          targets.forEach(({ edge, dir }) => {
            dir.binds = binds;
            if (!edge.binds) edge.binds = [];
            binds.forEach((b) => {
              if (!edge.binds.some((eb) => eb.motif_id === b.motif_id && eb.start === b.start && eb.strand === b.strand)) {
                edge.binds.push(b);
              }
            });
          });
        });
      } else {
        await Promise.all(
          batch.map(async (pair) => {
            try {
              const res = await fetch(`${apiBase}/api/network/edges/binds?source=${encodeURIComponent(pair.source)}&target=${encodeURIComponent(pair.target)}`);
              if (res.ok) {
                const { binds } = await res.json();
                const key = `${pair.source}->${pair.target}`;
                const targets = pairMap.get(key) || [];
                targets.forEach(({ edge, dir }) => {
                  dir.binds = binds || [];
                  if (!edge.binds) edge.binds = [];
                  (binds || []).forEach((b) => {
                    if (!edge.binds.some((eb) => eb.motif_id === b.motif_id && eb.start === b.start && eb.strand === b.strand)) {
                      edge.binds.push(b);
                    }
                  });
                });
              }
            } catch (e) {}
          })
        );
      }
    } catch (e) {
      console.warn("fetchBindsForEdges error:", e);
    }
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
    const response = await fetch(`${typeof API_BASE !== "undefined" ? API_BASE : ""}/api/network/clusters`);
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
  if (loaderText) loaderText.innerText = "FETCHING LIGHTWEIGHT TOPOLOGY...";
  if (progressBar) progressBar.style.width = "10%";
  await new Promise(r => setTimeout(r, 50));

  try {
    const response = await fetch(`${typeof API_BASE !== "undefined" ? API_BASE : ""}/api/network/init`);
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
      n.identifier = n.identifier || "";

      if (n.msu_id) n.metadata["MSU_ID"] = n.msu_id;
      if (n.identifier) n.metadata["Identifier"] = n.identifier;

      if (window.applyNodeTypeStyling) window.applyNodeTypeStyling(n);
    });

    if (typeof cacheMetaSnapshot === "function") cacheMetaSnapshot();

    const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
    links = RAW_DATA.links
      .map((e) => ({
        source: nodeMap.get(String(e.source?.id || e.source)),
        target: nodeMap.get(String(e.target?.id || e.target)),
        weight: e.weight || e.value || 1,
        irp: e.irp !== undefined && e.irp !== null ? e.irp : null,
        sign: e.sign || null,
        has_interacts: e.has_interacts !== undefined ? e.has_interacts : true,
        has_regulates: e.has_regulates || false,
        directions: e.directions || null,
        binds: e.binds || null,
        reg_matched: false
      }))
      .filter((l) => l.source && l.target);

    RAW_DATA.adjacency = buildAdjacency(nodes, links);

    if (nodes.length > 0 && nodes.some((n) => n.x !== undefined && n.x !== null)) {
      if (loaderText) loaderText.innerText = "RENDERING...";
      if (progressBar) progressBar.style.width = "100%";
      if (typeof finishSetup === "function") finishSetup(true);
      if (loader) loader.style.display = "none";
      if (document.body && document.body.classList) document.body.classList.remove("is-loading");
    } else {
      if (loaderText) loaderText.innerText = "PREPARING PHYSICS...";
      if (progressBar) progressBar.style.width = "100%";
      await new Promise(r => setTimeout(r, 50));
      if (document.body && document.body.classList) document.body.classList.remove("is-loading");
      if (typeof startCalculation === "function") startCalculation(true);
    }
  } catch (error) {
    console.error("Failed to fetch from Neo4j API.", error);
    if (loaderText) loaderText.innerText = "Error: Database connection failed";
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
  if (typeof window.updateIRPControlUI === "function") window.updateIRPControlUI(0);
  if (typeof window.closeDetails === "function") window.closeDetails();

  const tooltipEl = document.getElementById("tooltip");
  if (tooltipEl) tooltipEl.style.display = "none";
  const ctxMenu = document.getElementById("context-menu");
  if (ctxMenu) ctxMenu.style.display = "none";

  if (typeof simulation !== "undefined" && simulation) simulation.stop();

  window.IS_IMPORTED_NETWORK = false;
  window.IS_FILTERED_NETWORK = false;
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
    if (RAW_DATA && Array.isArray(RAW_DATA.dbNodes) && RAW_DATA.dbNodes.length > 0 && Array.isArray(RAW_DATA.dbLinks)) {
      if (loaderText) loaderText.innerText = "RESTORING EMBEDDED TOPOLOGY...";
      if (progressBar) progressBar.style.width = "30%";
      await nextPaint();

      RAW_DATA.nodes = RAW_DATA.dbNodes.map((n) => ({ ...n }));
      RAW_DATA.links = RAW_DATA.dbLinks.map((e) => ({ ...e }));

      nodes = RAW_DATA.nodes.map((n) => ({ ...n }));
      RAW_DATA.workingNodes = nodes;
      RAW_DATA.workingLinks = null;

      if (typeof loadClusters === "function") {
        if (loaderText) loaderText.innerText = "FETCHING CLUSTERS...";
        if (progressBar) progressBar.style.width = "55%";
        await nextPaint();
        await loadClusters();
      }

      if (loaderText) loaderText.innerText = "PREPARING METADATA & LINKS...";
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

      const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
      links = RAW_DATA.links
        .map((e) => ({
          source: nodeMap.get(String(e.source?.id || e.source)),
          target: nodeMap.get(String(e.target?.id || e.target)),
          weight: e.weight || e.value || 1,
          irp: e.irp !== undefined && e.irp !== null ? e.irp : null,
          sign: e.sign || null,
          has_interacts: e.has_interacts !== undefined ? e.has_interacts : true,
          has_regulates: e.has_regulates || false,
          directions: e.directions || null,
          binds: e.binds || null,
          reg_matched: false,
        }))
        .filter((l) => l.source && l.target);

      RAW_DATA.adjacency = buildAdjacency(nodes, links);

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
window.__APP_CORE__.cacheMetaSnapshot = cacheMetaSnapshot;
window.__APP_CORE__.revertToEmbeddedNetworkCore = window.revertToEmbeddedNetworkCore;
