/**
 * legends.js - Network Legend UI & Visibility Control Module
 * 
 * Manages rendering of node type legends, target gene indicators, edge type toggles,
 * and functional cluster module filters.
 */

/**
 * Initializes HTML DOM structure for sidebar legend containers.
 */
function initLegendStructure() {
  const legend = document.getElementById("legend");
  if (!legend) return;

  let types = document.getElementById("legend-types");
  let target = document.getElementById("legend-target");
  let edges = document.getElementById("legend-edges");
  let clusters = document.getElementById("legend-clusters");

  if (types && target && edges && clusters) {
    legend.appendChild(types);
    legend.appendChild(target);
    legend.appendChild(edges);
    legend.appendChild(clusters);
    types.style.pointerEvents = "auto";
    target.style.pointerEvents = "auto";
    edges.style.pointerEvents = "auto";
    clusters.style.pointerEvents = "auto";
    return;
  }

  legend.innerHTML = "";
  legend.style.display = "flex";
  legend.style.flexDirection = "column";
  legend.style.gap = "10px";
  legend.style.maxHeight = "90vh";
  legend.style.overflowY = "auto";

  types = document.createElement("div");
  types.id = "legend-types";
  types.style.display = "flex";
  types.style.flexDirection = "column";
  types.style.gap = "4px";
  types.style.pointerEvents = "auto";
  legend.appendChild(types);

  target = document.createElement("div");
  target.id = "legend-target";
  target.style.display = "none";
  target.style.flexDirection = "column";
  target.style.marginTop = "5px";
  target.style.paddingTop = "5px";
  target.style.borderTop = "1px solid #444";
  target.style.pointerEvents = "auto";
  legend.appendChild(target);

  edges = document.createElement("div");
  edges.id = "legend-edges";
  edges.style.display = "flex";
  edges.style.flexDirection = "column";
  edges.style.gap = "4px";
  edges.style.marginTop = "10px";
  edges.style.paddingTop = "10px";
  edges.style.borderTop = "1px solid #444";
  edges.style.pointerEvents = "auto";
  legend.appendChild(edges);

  clusters = document.createElement("div");
  clusters.id = "legend-clusters";
  clusters.style.display = "flex";
  clusters.style.flexDirection = "column";
  clusters.style.gap = "4px";
  clusters.style.pointerEvents = "auto";
  legend.appendChild(clusters);
}

/**
 * Renders target gene indicator legend control.
 */
window.renderTargetLegend = function () {
  const legendTarget = document.getElementById("legend-target");
  if (!legendTarget) return;

  const text = document.getElementById("target-input").value;
  const rawTargets = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const targetSet = window.resolveTargetIds
    ? window.resolveTargetIds(rawTargets)
    : new Set(rawTargets);
  const hasTargets = targetSet.size > 0;

  legendTarget.style.display = hasTargets ? "flex" : "none";

  if (hasTargets) {
    let st = VISIBILITY_STATE.Target;
    if (st === true) st = 2;
    if (st === false) st = 0;

    const opacity = st === 0 ? "0.4" : "1";
    const getIcon = (state) => {
      if (state === 2)
        return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
      if (state === 1)
        return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3" stroke-dasharray="2 2"></circle></svg>`;
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"></path><path d="M12 4c1.66 0 3.2.46 4.54 1.25"></path></svg>`;
    };

    let displayColor =
      st === 1 ? CONFIG.visuals.colors.Gene : CONFIG.visuals.colors.Green;

    legendTarget.innerHTML = `
      <div style="display:grid; grid-template-columns: 24px 1fr 30px; align-items:center; width:100%; font-size:0.85rem; opacity:${opacity}; transition: opacity 0.2s;">
        <div style="display:flex; align-items:center; justify-content:center;">
          <div style="width:10px; height:10px; border-radius:50%; background:${displayColor};"></div>
        </div>
        <span style="padding-left: 8px;">Target Gene</span>
        <div onclick="event.stopPropagation(); window.toggleType('Target')" style="cursor:pointer; display:flex; align-items:center; justify-content:center; color:#bbb; pointer-events:auto;" title="Toggle Visibility">
          ${getIcon(st)}
        </div>
      </div>
    `;
  }
};

/**
 * Renders node type legend items (TF, Predicted TF, Predicted TR, Annotated Gene, Gene, Rogue Gene).
 */
window.renderTypeLegend = function () {
  const container = document.getElementById("legend-types");
  if (!container) return;

  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "4px";

  const getIcon = (state) => {
    if (state === 2)
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    if (state === 1)
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3" stroke-dasharray="2 2"></circle></svg>`;
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"></path><path d="M12 4c1.66 0 3.2.46 4.54 1.25"></path></svg>`;
  };

  const items = [
    { label: "Transcription Factor", color: CONFIG.visuals.colors.TF, state: VISIBILITY_STATE.TF, key: "TF", shape: "diamond", hollow: false, dashed: false },
    { label: "Predicted TF", color: CONFIG.visuals.colors.Predicted, state: VISIBILITY_STATE.PredictedTF, key: "PredictedTF", shape: "diamond", hollow: false, dashed: false },
    { label: "Predicted TR", color: CONFIG.visuals.colors.Predicted, state: VISIBILITY_STATE.PredictedTR, key: "PredictedTR", shape: "diamond", hollow: true, dashed: false },
    { label: "Annotated Gene", color: CONFIG.visuals.colors.AnnotatedGene, state: VISIBILITY_STATE.AnnotatedGene, key: "AnnotatedGene", shape: "circle", hollow: true, dashed: false },
    { label: "Other Gene", color: CONFIG.visuals.colors.Gene, state: VISIBILITY_STATE.Gene, key: "Gene", shape: "circle", hollow: true, dashed: false },
    { label: "Rogue Gene", color: THEME === "dark" ? "#ffffff" : "#000000", state: VISIBILITY_STATE.Rogue, key: "Rogue", shape: "circle", hollow: true, dashed: true },
  ];

  const markerHtml = (item) => {
    let st = item.state;
    if (st === true) st = 2;
    if (st === false) st = 0;

    let displayColor = st === 1 ? CONFIG.visuals.colors.Gene : item.color;
    let displayShape = st === 1 ? "circle" : item.shape;
    let displayHollow = st === 1 ? false : item.hollow;
    let displayDashed = st === 1 ? false : item.dashed;

    const common = [
      "display:block",
      "width:10px",
      "height:10px",
      "margin: 0 auto",
      displayShape === "diamond" ? "transform:rotate(45deg)" : "border-radius:50%",
      `border:${displayHollow ? 2 : 1}px ${displayDashed ? "dashed" : "solid"} ${displayColor}`,
      `background:${displayHollow ? "transparent" : displayColor}`,
      "box-sizing:border-box",
    ].join(";");
    return `<div style="${common}"></div>`;
  };

  container.innerHTML =
    `<div style="font-size:0.8rem; color:#888; margin-bottom:4px; font-weight:bold; text-align:right; padding-right:4px;">TYPES</div>` +
    items.map((item) => {
      let st = item.state;
      if (st === true) st = 2;
      if (st === false) st = 0;
      const opacity = st === 0 ? "0.4" : "1";
      return `
      <div style="display:grid; grid-template-columns: 24px 1fr 30px; align-items:center; font-size:0.85rem; opacity:${opacity}; transition: opacity 0.2s; cursor:default; pointer-events:auto; margin-bottom: 6px;">
        <div style="display:flex; align-items:center; justify-content:center;">
          ${markerHtml({ ...item, state: st })}
        </div>
        <span style="padding-left: 8px;">${item.label}</span>
        <div onclick="event.stopPropagation(); window.toggleType('${item.key}')" style="cursor:pointer; display:flex; align-items:center; justify-content:center; color:#bbb; pointer-events:auto;" title="Toggle Visibility">
          ${getIcon(st)}
        </div>
      </div>
    `;
    }).join("");
};

/**
 * Renders edge type legend items (Coexpression, Regulation).
 */
window.renderEdgeLegend = function () {
  const container = document.getElementById("legend-edges");
  if (!container) return;

  const getIcon = (state) => {
    if (state === 2)
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"></path><path d="M12 4c1.66 0 3.2.46 4.54 1.25"></path></svg>`;
  };

  const edgeColor = THEME === "dark" ? "#ffffff" : "#000000";

  const items = [
    { label: "Coexpression", key: "EdgeCoexp", icon: `<div style="width:20px; height:2px; background:${edgeColor};"></div>` },
    { label: "Regulation", key: "EdgeBoth", icon: `<div style="display:flex; align-items:center;"><div style="width:14px; height:2px; background:${edgeColor};"></div><div style="width:0; height:0; border-top:4px solid transparent; border-bottom:4px solid transparent; border-left:6px solid ${edgeColor};"></div></div>` },
  ];

  container.innerHTML =
    `<div style="font-size:0.8rem; color:#888; margin-bottom:4px; font-weight:bold; text-align:right; padding-right:4px;">EDGE TYPES</div>` +
    items.map((item) => {
      let st = VISIBILITY_STATE[item.key] ?? (item.key === "EdgeCoexp" ? 2 : 0);
      const opacity = st === 0 ? "0.4" : "1";

      return `
        <div style="display:grid; grid-template-columns: 24px 1fr 30px; align-items:center; font-size:0.85rem; opacity:${opacity}; transition: opacity 0.2s; cursor:default; pointer-events:auto; margin-bottom: 6px;">
          <div style="display:flex; align-items:center; justify-content:center;">${item.icon}</div>
          <span style="padding-left: 8px;">${item.label}</span>
          <div onclick="event.stopPropagation(); window.toggleEdgeType('${item.key}')" style="cursor:pointer; display:flex; align-items:center; justify-content:center; color:#bbb;" title="Toggle Visibility">
            ${getIcon(st)}
          </div>
        </div>
        `;
    }).join("");
};

/**
 * Renders functional cluster module legend list.
 */
window.renderClusterLegend = function () {
  const container = document.getElementById("legend-clusters");
  if (!container) return;

  if (CLUSTER_STATE.legend.length === 0 || CLUSTER_STATE.isAvailable === false) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "block";
  container.style.marginTop = "10px";
  container.style.paddingTop = "10px";
  container.style.borderTop = "1px solid #444";

  const existingDetails = container.querySelector("details");
  const isOpen = existingDetails && existingDetails.hasAttribute("open") ? "open" : "";
  const allActive = CLUSTER_STATE.active.size === CLUSTER_STATE.legend.length;

  const headerIcon = allActive
    ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`
    : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"></path><path d="M12 4c1.66 0 3.2.46 4.54 1.25"></path></svg>`;

  const headerHtml = `
    <details ${isOpen} style="width:100%; pointer-events:auto;">
      <summary style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:0.8rem; color:#888; font-weight:bold; cursor:pointer; list-style:none; user-select:none; pointer-events:auto;">
        <div style="display:flex; align-items:center; gap:5px;">
          <svg class="dropdown-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s;"><polyline points="6 9 12 15 18 9"></polyline></svg>
          <span>CLUSTERS</span>
        </div>
        <div onclick="event.preventDefault(); event.stopPropagation(); window.toggleAllClusters()" style="cursor:pointer; color:#bbb; pointer-events:auto;" title="${allActive ? "Hide All" : "Show All"}">${headerIcon}</div>
      </summary>
      <div style="display:flex; flex-direction:column; gap:4px; margin-top:8px; padding-left:17px; pointer-events:auto;">
  `;

  const htmlRows = [...CLUSTER_STATE.legend]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((c) => {
      const isActive = CLUSTER_STATE.active.has(c.name);
      const opacity = isActive ? "1" : "0.4";
      const icon = isActive
        ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`
        : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"></path><path d="M12 4c1.66 0 3.2.46 4.54 1.25"></path></svg>`;

      return `
      <div style="display:grid; grid-template-columns: 24px 1fr 30px; align-items:center; font-size:0.85rem; opacity:${opacity}; transition: opacity 0.2s; cursor:default; pointer-events:auto; margin-bottom: 6px;">
        <div style="display:flex; align-items:center; justify-content:center;">
          <div style="width:10px; height:10px; border-radius:0; background:${c.color};"></div>
        </div>
        <span style="padding-left: 8px;">${c.name}</span>
        <div onclick="event.stopPropagation(); window.toggleCluster('${c.name}')" style="cursor:pointer; display:flex; align-items:center; justify-content:center; color:#bbb; pointer-events:auto;" title="Toggle Visibility">
          ${icon}
        </div>
      </div>
    `;
    }).join("");

  container.innerHTML = headerHtml + htmlRows + `</div></details>`;

  if (!document.getElementById("cluster-style")) {
    const style = document.createElement("style");
    style.id = "cluster-style";
    style.innerHTML = `
      details > summary::-webkit-details-marker { display: none; }
      details[open] .dropdown-arrow { transform: rotate(180deg); }
    `;
    document.head.appendChild(style);
  }
};

/**
 * Toggles visibility state for a node type category.
 * @param {string} type - Visibility key.
 */
window.toggleType = function (type) {
  if (VISIBILITY_STATE[type] !== undefined) {
    let current = VISIBILITY_STATE[type];
    if (current === true) current = 2;
    if (current === false) current = 0;

    if (type === "Gene") {
      VISIBILITY_STATE[type] = current === 2 ? 0 : 2;
    } else {
      VISIBILITY_STATE[type] = current === 2 ? 1 : current === 1 ? 0 : 2;
    }
  }
  window.reapplyColors();

  if (type === "Rogue" && VISIBILITY_STATE.Rogue > 0) {
    if (typeof window.autoFit === "function") window.autoFit();
  }
};

/**
 * Toggles edge type visibility (Coexpression or Regulation).
 * @param {string} key - Edge visibility key ("EdgeCoexp" or "EdgeBoth").
 */
window.toggleEdgeType = async function (key) {
  if (key === "EdgeBoth") {
    let current = VISIBILITY_STATE[key] ?? 0;
    if (current === 0) {
      await window.fetchRegulationEdges();
    }
  }
  let current = VISIBILITY_STATE[key] ?? (key === "EdgeCoexp" ? 2 : 0);
  VISIBILITY_STATE[key] = current === 2 ? 0 : 2;
  window.reapplyColors();
};

/**
 * Toggles active state for a functional cluster module.
 * @param {string} name - Cluster module name.
 */
window.toggleCluster = function (name) {
  if (CLUSTER_STATE.active.has(name)) CLUSTER_STATE.active.delete(name);
  else CLUSTER_STATE.active.add(name);
  window.reapplyColors();
};

/**
 * Toggles active state for all functional cluster modules simultaneously.
 */
window.toggleAllClusters = function () {
  const total = CLUSTER_STATE.legend.length;
  const current = CLUSTER_STATE.active.size;
  if (current === total) CLUSTER_STATE.active.clear();
  else {
    CLUSTER_STATE.active.clear();
    CLUSTER_STATE.legend.forEach((c) => CLUSTER_STATE.active.add(c.name));
  }
  window.reapplyColors();
};
