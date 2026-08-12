/**
 * graph.js - Visual Styling, Zooming, and Camera Navigation Module
 * 
 * Manages color re-application, node visibility calculations, D3 zoom behaviors,
 * pan/select interactive mode toggling, and automatic camera framing (autoFit).
 */

/** D3 Zoom Behavior setup with scale extent limits */
const zoomBehavior = d3.zoom().scaleExtent([0.1, 10]);

/**
 * Re-applies node and link visual styling based on current legend toggles, target inputs,
 * functional cluster assignments, and node degree connectivity.
 */
window.reapplyColors = function () {
  if (typeof initIRPControls === "function") initIRPControls();
  if (typeof initLegendStructure === "function") initLegendStructure();

  if (typeof VISIBILITY_STATE.Target === "undefined") {
    VISIBILITY_STATE.Target = 2;
  }

  const text = document.getElementById("target-input").value;
  const rawTargets = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const targetSet = window.resolveTargetIds
    ? window.resolveTargetIds(rawTargets)
    : new Set(rawTargets);
  const hasTargets = targetSet.size > 0;

  window.renderTargetLegend();
  window.renderTypeLegend();
  window.renderEdgeLegend();
  window.renderClusterLegend();

  // Compute node degrees based on visible edges
  const nodeDegrees = new Map();
  nodes.forEach((n) => nodeDegrees.set(n.id, 0));

  links.forEach((l) => {
    if (window.isEdgeVisible ? window.isEdgeVisible(l) : true) {
      const sid = typeof l.source === "object" ? l.source.id : l.source;
      const tid = typeof l.target === "object" ? l.target.id : l.target;
      nodeDegrees.set(sid, (nodeDegrees.get(sid) || 0) + 1);
      nodeDegrees.set(tid, (nodeDegrees.get(tid) || 0) + 1);
    }
  });

  // Evaluate visual properties for each node
  nodes.forEach((n) => {
    const deg = nodeDegrees.get(n.id) || 0;
    n.isRogue = deg === 0;

    const baseSpec = window.getTypeVisualSpec
      ? window.getTypeVisualSpec(n.originalType || "Gene")
      : { shape: "circle", label: "Gene", color: CONFIG.visuals.colors.Gene, visibilityKey: "Gene" };

    let state = VISIBILITY_STATE[baseSpec.visibilityKey];
    if (state === true) state = 2;
    if (state === false) state = 0;

    let isHighlighted = state === 2;
    let isVisible = state > 0;
    let finalColor = baseSpec.color;
    let finalLabel = baseSpec.label;
    let isTargetMatched = false;

    // Evaluate functional cluster overlays
    if (CLUSTER_STATE.data.has(n.id)) {
      const clusterName = CLUSTER_STATE.data.get(n.id);
      if (CLUSTER_STATE.active.has(clusterName)) {
        const cMeta = CLUSTER_STATE.legend.find((x) => x.name === clusterName);
        if (cMeta) {
          isHighlighted = true;
          isVisible = true;
          if (baseSpec.visibilityKey === "Gene" || baseSpec.visibilityKey === "AnnotatedGene") {
            finalColor = cMeta.color;
          }
          finalLabel = clusterName;
        }
      }
    }

    // Evaluate target gene match status
    let targetState = VISIBILITY_STATE.Target;
    if (targetState === true) targetState = 2;
    if (targetState === false) targetState = 0;

    if (hasTargets && targetSet.has(n.id)) {
      isTargetMatched = true;
      if (targetState > 0) {
        isVisible = true;
        if (targetState === 2) {
          isHighlighted = true;
          finalColor = CONFIG.visuals.colors.Green;
        } else {
          isHighlighted = false;
        }
        finalLabel = "Target Gene";
      }
    }

    // Evaluate isolated/rogue node visibility
    let rogueState = VISIBILITY_STATE.Rogue;
    if (rogueState === true) rogueState = 2;
    if (rogueState === false) rogueState = 0;

    if (n.isRogue) {
      if (rogueState === 0) {
        isVisible = false;
      } else if (!isTargetMatched && state === 0) {
        isVisible = false;
      } else {
        isVisible = true;
        if (rogueState === 1 && !isTargetMatched && state !== 2) {
          isHighlighted = false;
        }
      }
      if (isVisible) finalLabel += " (Rogue)";
    }

    // Apply resolved colors and stroke properties
    if (!isVisible) {
      n.color = CONFIG.visuals.colors.Transparent;
      n.fillColor = CONFIG.visuals.colors.Transparent;
      n.strokeColor = CONFIG.visuals.colors.Transparent;
      n.typeLabel = finalLabel;
    } else if (!isHighlighted) {
      n.color = CONFIG.visuals.colors.Gene;
      n.shape = "circle";
      n.hollow = baseSpec.hollow;
      n.dashed = n.isRogue;
      n.typeLabel = finalLabel;
      n.fillColor = baseSpec.hollow ? CONFIG.visuals.colors.Transparent : CONFIG.visuals.colors.Gene;
      n.strokeColor = CONFIG.visuals.colors.Gene;
    } else {
      if (window.applyNodeTypeStyling) {
        window.applyNodeTypeStyling(n, finalColor, finalLabel);
        if (n.isRogue) n.dashed = true;
        if (isTargetMatched) {
          n.hollow = false;
          n.fillColor = finalColor;
          n.strokeColor = finalColor;
          n.strokeWidth = 2;
        }
      } else {
        n.color = finalColor;
        n.shape = baseSpec.shape;
        n.typeLabel = finalLabel;
        if (isTargetMatched) n.hollow = false;
      }
    }
  });

  window.updateTargetCounts();
  if (typeof window.updateActiveCounts === "function") window.updateActiveCounts();
  requestAnimationFrame(window.draw);
};

/**
 * Triggers full visual color re-application across the network view.
 */
window.highlightCurrentView = function () {
  window.reapplyColors();
};

/**
 * Automatically adjusts camera scale and translation to center all visible graph elements.
 */
window.autoFit = function () {
  if (nodes.length === 0) return;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  let hasVisible = false;

  for (const n of nodes) {
    if (n.color === CONFIG.visuals.colors.Transparent) continue;
    if (n.isRogue && !VISIBILITY_STATE.Rogue) continue;

    hasVisible = true;
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }

  if (!hasVisible) {
    minX = 0;
    maxX = 1;
    minY = 0;
    maxY = 1;
  }
  const graphW = maxX - minX;
  const graphH = maxY - minY;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const padding = 0.95;
  const scale = Math.min(width / graphW, height / graphH) * padding;
  const tx = (width + 280) / 2 - scale * midX;
  const ty = height / 2 - scale * midY;
  const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
  if (CURRENT_MODE === "pan") d3.select(canvas).call(zoomBehavior.transform, t);
  transform = t;
  isInteracting = false;
  requestAnimationFrame(window.draw);
};

/**
 * Toggles canvas interaction mode between "pan" (panning/zooming) and "select" (node/edge selection).
 * @param {string} mode - Interaction mode ("pan" or "select").
 */
window.setMode = function (mode) {
  CURRENT_MODE = mode;
  document.body.className = mode === "pan" ? "mode-pan" : "mode-select";
  const panBtn = document.getElementById("tool-pan");
  const selBtn = document.getElementById("tool-select");

  if (mode === "pan") {
    panBtn.classList.add("active");
    selBtn.classList.remove("active");
  } else {
    panBtn.classList.remove("active");
    selBtn.classList.add("active");
  }

  if (mode === "pan") {
    d3.select(canvas).on(".zoom", null);
    zoomBehavior.on("zoom", (e) => {
      transform = e.transform;
      isInteracting = true;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        isInteracting = false;
        requestAnimationFrame(window.draw);
      }, 2000);
      requestAnimationFrame(window.draw);
    });
    d3.select(canvas).call(zoomBehavior);
    d3.select(canvas).on("click", null).on("mousemove", null);
    document.getElementById("tooltip").style.display = "none";
  } else {
    d3.select(canvas).on(".zoom", null);
    d3.select(canvas).on("mousemove", onMouseMoveSelect);
    d3.select(canvas).on("click", onClickSelect);
  }
};
