/**
 * globals.js - Global State & Configuration Registry
 * 
 * Central registry for application state, theme palettes, visual specifications,
 * random number generation, visibility state, and global utility helpers.
 */

// Seeded random number generator for reproducible force layout simulations
let _seed = 42;
function mulberry32(a) {
  return function () {
    var t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(_seed);
function random() {
  return rng();
}

/** Global Application Theme & Performance Limits */
let THEME = "dark";
const PERFORMANCE_LIMIT = 5000;
const PERFORMANCE_LIMIT_EDGES = 40000;

/** Canvas Interaction Mode & Selection State */
let CURRENT_MODE = "pan";
let SELECTED_NODE = null;
let HOVERED_EDGE = null;

/** Primary Raw Network Topology Storage */
let RAW_DATA = { nodes: [], links: [], adjacency: new Map() };

/** Functional Cluster Annotations State */
let CLUSTER_STATE = {
  data: new Map(),
  active: new Set(),
  legend: [],
};

/**
 * Global Legend Visibility Toggles State
 * Tracks visibility levels for node types, target selections, rogue nodes,
 * coexpression edges, and regulation edges.
 */
let VISIBILITY_STATE = {
  TF: true,
  PredictedTF: true,
  PredictedTR: true,
  AnnotatedGene: true,
  Gene: true,
  Target: true,
  Rogue: false,
  EdgeCoexp: 2,
  EdgeBoth: 0,
  EdgeReg: 0,
};

let HAS_LOADED_REGULATES = false;

/**
 * Checks whether regulation edge rendering mode is currently active.
 * @returns {boolean} True if regulation edges are visible.
 */
window.isRegulationActive = function () {
  return (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;
};

/**
 * Determines whether a given network edge should be visible based on active legend toggles.
 * @param {Object} l - Edge link object.
 * @returns {boolean} True if the edge is visible.
 */
window.isEdgeVisible = function (l) {
  const hasInt = l.has_interacts !== false;
  const hasReg = !!(l.has_regulates && (Array.isArray(l.directions) ? l.directions.length > 0 : true));
  const isRegActive = window.isRegulationActive();

  if (isRegActive && hasReg) return true;
  if (hasInt) return (VISIBILITY_STATE.EdgeCoexp ?? 2) > 0;
  if (hasReg) return (VISIBILITY_STATE.EdgeReg ?? 0) > 0;
  return false;
};

/**
 * Returns the currently active gene ID export format ("MSU" or "RAP").
 * @returns {string} ID mode string.
 */
window.getExportIdMode = function () {
  const checkbox = document.getElementById("export-id-mode");
  return checkbox && checkbox.checked ? "MSU" : "RAP";
};

document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("export-id-mode");
  const label = document.getElementById("export-id-mode-label");
  if (checkbox && label) {
    checkbox.addEventListener("change", (e) => {
      label.innerText = e.target.checked ? "MSU IDs" : "RAP IDs";
    });
  }
});

/**
 * Resolves the appropriate node identifier based on the user's export ID setting.
 * @param {Object} node - Node object.
 * @returns {string} Formatted node ID.
 */
window.getExportNodeId = function (node) {
  if (!node) return "";
  const mode = window.getExportIdMode();
  const normalize = (value, isMsu = false) => {
    if (value === undefined || value === null) return "";
    const first = String(value)
      .split(",")
      .map((s) => s.trim())
      .find(Boolean);
    if (
      !first ||
      first.toLowerCase() === "none" ||
      first.toLowerCase() === "null"
    )
      return "";
    return isMsu ? first.replace(/\.\d+$/, "") : first;
  };

  const rap =
    normalize(node.id) ||
    normalize(node.metadata?.RAP_ID) ||
    normalize(node.metadata?.["RAP ID"]);
  const msu =
    normalize(node.msu_id, true) ||
    normalize(node.metadata?.MSU_ID, true) ||
    normalize(node.metadata?.["MSU ID"], true);

  if (mode === "MSU") return msu || rap || String(node.id || "");
  else return rap || msu || String(node.id || "");
};

/** Integrated Rank Prediction (IRP) Filter Threshold State */
let IRP_STATE = { threshold: 0.0 };

const PARAMS = new URLSearchParams(window.location.search);

/** Default cluster definitions for functional module annotations */
let clusterFiles = [
  "A - response to external biotic stimulus.txt",
  "B - photosynthesis.txt",
  "C - translation.txt",
  "D - transcription.txt",
  "E - response to stress.txt",
  "F - stress signalling.txt",
  "G - transmembrane transport.txt",
  "H - protein folding.txt",
  "I - cell wall biogenisis, cytoskeleton organization, mitosis.txt",
  "J - cell cycle.txt",
  "K - RNA modification.txt",
  "M - electron transport chain, ribossome.txt",
];
let clusterNames = clusterFiles.map((f) => f.replace(/\.txt$/i, ""));

/**
 * Updates the active cluster file registry.
 * @param {Array<string>} fileList - List of cluster filenames.
 */
window.processClusterDirectory = function (fileList) {
  if (!Array.isArray(fileList)) return;

  clusterFiles = fileList.filter((f) => f.toLowerCase().endsWith(".txt"));
  clusterNames = clusterFiles.map((f) => f.replace(/\.txt$/i, ""));

  if (typeof CONFIG !== "undefined" && CONFIG.files) {
    CONFIG.files.clusters = clusterFiles;
  }
};

/** Dark Theme Color Palette Definition */
const DARK_PALETTE = {
  EdgeRGB: "200, 200, 200",
  Transparent: "rgba(0,0,0,0)",
  TF: "#FF0000",
  Predicted: "#FFD700",
  Green: "#32CD32",
  Gene: "#00ffff",
  AnnotatedGene: "#1E6FB8",
  Clusters: [
    "#FF3B30", // Vibrant Red
    "#00FF40", // Neon Green
    "#1E90FF", // Dodger Blue
    "#FFD700", // Gold/Yellow
    "#FF00FF", // Magenta
    "#00FFFF", // Cyan
    "#FF8C00", // Dark Orange
    "#B026FF", // Neon Purple
    "#ADFF2F", // Green-Yellow / Chartreuse
    "#FF69B4", // Hot Pink
    "#00FA9A", // Medium Spring Green
    "#BCAADB", // Soft Lilac/Periwinkle
  ],
};

/** Light Theme Color Palette Definition */
const LIGHT_PALETTE = {
  EdgeRGB: "40, 40, 40",
  Transparent: "rgba(0,0,0,0)",
  TF: "#CC0000",
  Predicted: "#D69E00",
  Green: "#32CD32",
  Gene: "#008080",
  AnnotatedGene: "#0b4a87",
  Clusters: [
    "#E6194B", // Punchy Red
    "#3CB44B", // Punchy Green
    "#4363D8", // Royal Blue
    "#F58231", // Bright Orange
    "#911EB4", // Deep Purple
    "#F032E6", // Bright Magenta
    "#00BFFF", // Deep Sky Blue
    "#E5A800", // Goldenrod
    "#8CB302", // Apple Green / Olive
    "#008080", // Raspberry Pink
    "#D81B60", // Teal
    "#4B0082", // Indigo
  ],
};

/** Master Application Visual & Physics Configuration */
const CONFIG = {
  files: {
    json: "main_network.json",
    edges: PARAMS.get("edges") || "edges.tsv",
    metadata: PARAMS.get("meta") || "metadata.json",
    green: PARAMS.get("green") || "green_list.tsv",
    clusterDir: "clusters/",
    clusters: clusterFiles,
  },
  visuals: {
    baseSize: parseFloat(PARAMS.get("baseSize")) || 2,
    sizeMult: parseFloat(PARAMS.get("sizeMult")) || 2.5,
    edgeWidth: parseFloat(PARAMS.get("edgeWidth")) || 0.3,
    edgeAlpha: 0.5,
    rogueOpacity: 0.2,
    colors: THEME === "light" ? { ...LIGHT_PALETTE } : { ...DARK_PALETTE },
  },
  physics: {
    repulsion: 300,
    linkDist: 5,
    collision: 0.8,
    radial: 0.1,
    initialTicks: 400,
  },
};

/**
 * Checks whether a given node type string represents a transcription factor or related regulator.
 * @param {string} type - Node type string.
 * @returns {boolean} True if type is TF-like.
 */
window.isTfLikeType = function (type) {
  const t = String(type || "")
    .trim()
    .toLowerCase();
  return (
    t === "tf" ||
    t === "transcription factor" ||
    t === "predicted tf" ||
    t === "predicted tr"
  );
};

/**
 * Returns visual rendering specifications (shape, color, label, visibility key) for a node type.
 * @param {string} type - Node type identifier.
 * @returns {Object} Visual specification object.
 */
window.getTypeVisualSpec = function (type) {
  const t = String(type || "Gene")
    .trim()
    .toLowerCase();

  if (t === "tf" || t === "transcription factor") {
    return {
      label: "Transcription Factor",
      shape: "diamond",
      color: CONFIG.visuals.colors.TF,
      hollow: false,
      dashed: false,
      visibilityKey: "TF",
    };
  } else if (t === "predicted tf") {
    return {
      label: "Predicted TF",
      shape: "diamond",
      color: CONFIG.visuals.colors.Predicted,
      hollow: false,
      dashed: false,
      visibilityKey: "PredictedTF",
    };
  } else if (t === "predicted tr") {
    return {
      label: "Predicted TR",
      shape: "diamond",
      color: CONFIG.visuals.colors.Predicted,
      hollow: true,
      dashed: false,
      visibilityKey: "PredictedTR",
    };
  } else if (t === "annotated gene") {
    return {
      label: "Annotated Gene",
      shape: "circle",
      color: CONFIG.visuals.colors.AnnotatedGene,
      hollow: true,
      dashed: false,
      visibilityKey: "AnnotatedGene",
    };
  }

  return {
    label: "Gene",
    shape: "circle",
    color: CONFIG.visuals.colors.Gene,
    hollow: true,
    dashed: false,
    visibilityKey: "Gene",
  };
};

/**
 * Applies type-specific styling properties (colors, shapes, outlines) directly to a node object.
 * @param {Object} node - Target node object.
 * @param {string|null} colorOverride - Optional color override.
 * @param {string|null} labelOverride - Optional label override.
 */
window.applyNodeTypeStyling = function (
  node,
  colorOverride = null,
  labelOverride = null,
) {
  const spec = window.getTypeVisualSpec(node.originalType || "Gene");
  const color = colorOverride || spec.color;
  node.shape = spec.shape;
  node.typeLabel = labelOverride || spec.label;
  node.hollow = !!spec.hollow;
  node.dashed = !!spec.dashed;
  node.fillColor = spec.hollow ? CONFIG.visuals.colors.Transparent : color;
  node.strokeColor = color;
  node.color = color;
};

/**
 * Checks whether a given node type is visible based on VISIBILITY_STATE.
 * @param {string} type - Node type string.
 * @returns {boolean} True if visible.
 */
window.isTypeVisible = function (type) {
  const spec = window.getTypeVisualSpec(type);
  return !!VISIBILITY_STATE[spec.visibilityKey];
};

// Initialize UI control inputs with default configuration settings
document.getElementById("viz-base-size").value = CONFIG.visuals.baseSize;
document.getElementById("viz-size-mult").value = CONFIG.visuals.sizeMult;
document.getElementById("viz-edge-width").value = CONFIG.visuals.edgeWidth;
document.getElementById("viz-edge-alpha").value = CONFIG.visuals.edgeAlpha;
document.getElementById("phys-repulsion").value = CONFIG.physics.repulsion;
document.getElementById("phys-link-dist").value = CONFIG.physics.linkDist;
document.getElementById("phys-collision").value = CONFIG.physics.collision;
document.getElementById("phys-radial").value = CONFIG.physics.radial;

/** Global Simulation and Graph State Variables */
let simulation,
  isInteracting = false;
let nodes = [],
  links = [],
  quadtree;
let transform = d3.zoomIdentity;
let ticksDone = 0;
const totalTicks = CONFIG.physics.initialTicks;
const ticksPerFrame = 25;
let debounceTimer = null;
let highlightDebounce = null;

/**
 * Determines whether the current graph exceeds performance threshold limits.
 * @returns {boolean} True if the network is considered heavy.
 */
window.isHeavyGraph = function () {
  return (
    nodes.length > PERFORMANCE_LIMIT || links.length > PERFORMANCE_LIMIT_EDGES
  );
};

/** Canvas Initialization & Resize Handling */
const canvas = document.getElementById("network-canvas");
const ctx = canvas.getContext("2d");
let width, height;

function resize() {
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width;
  canvas.height = height;
  if (nodes.length > 0 && typeof window.draw === "function")
    requestAnimationFrame(window.draw);
}
window.addEventListener("resize", resize);
resize();

window.__APP_CORE__ = window.__APP_CORE__ || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
