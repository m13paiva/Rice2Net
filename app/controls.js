/**
 * controls.js - UI Event Listeners & Control Handlers Module
 * 
 * Configures dynamic Z-Score threshold sliders, target gene input parsing, target file upload listeners,
 * theme toggles, physics control bindings, and layout recalculation triggers.
 */

/**
 * Dynamically initializes the Z-Score threshold slider and number input elements inside Target Explorer.
 * Hidden automatically when the active network does not contain z_score edge attributes.
 */
function initZScoreControls() {
  const targetInput = document.getElementById("target-input");
  if (targetInput && !document.getElementById("zscore-control-container")) {
    const container = document.createElement("div");
    container.id = "zscore-control-container";
    container.style.marginTop = "15px";
    container.style.paddingTop = "10px";
    container.style.borderTop = "1px solid #444";
    container.style.pointerEvents = "auto";
    container.style.display = ZSCORE_STATE.enabled ? "block" : "none";

    const initMin = ZSCORE_STATE.min;
    const initMax = ZSCORE_STATE.max;
    const initVal = ZSCORE_STATE.enabled ? ZSCORE_STATE.threshold : DEFAULT_ZSCORE_THRESHOLD;

    container.innerHTML = `
      <div style="font-size:0.85rem; color:#bbb; margin-bottom:5px; display:flex; justify-content:space-between;">
        <span>Z-SCORE THRESHOLD</span>
        <span id="zscore-val-display" style="color:#fff;">${Number(initVal).toFixed(2)}</span>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <input type="range" id="zscore-slider" min="${initMin}" max="${initMax}" step="0.01" value="${initVal}" style="flex:1;">
        <input type="number" id="zscore-number" min="${initMin}" max="${initMax}" step="0.01" value="${initVal}" style="width:68px; background:#222; border:1px solid #555; color:#eee; padding:2px 4px; border-radius:3px;">
      </div>
    `;

    targetInput.parentNode.appendChild(container);

    const slider = document.getElementById("zscore-slider");
    const number = document.getElementById("zscore-number");
    const display = document.getElementById("zscore-val-display");
    let zscoreDebounceTimer = null;

    function clampThreshold(val) {
      let v = parseFloat(val);
      if (!Number.isFinite(v)) v = ZSCORE_STATE.defaultThreshold;
      if (v > ZSCORE_STATE.max) v = ZSCORE_STATE.max;
      if (v < ZSCORE_STATE.min) v = ZSCORE_STATE.min;
      return v;
    }

    function applyThreshold(v) {
      ZSCORE_STATE.threshold = v;
      if (typeof window.applyEdgeFilter === "function") {
        window.applyEdgeFilter();
      }
    }

    function updateUI(val) {
      const v = clampThreshold(val);
      slider.value = v;
      number.value = v;
      display.innerText = v.toFixed(2);
      return v;
    }

    function isLargeZScoreNetwork() {
      const srcNodes = (RAW_DATA && (RAW_DATA.workingNodes || RAW_DATA.nodes)) || nodes;
      const srcLinks = (RAW_DATA && (RAW_DATA.workingLinks || RAW_DATA.links)) || links;
      return (
        (srcNodes && srcNodes.length > PERFORMANCE_LIMIT) ||
        (srcLinks && srcLinks.length > PERFORMANCE_LIMIT_EDGES)
      );
    }

    slider.addEventListener("input", (e) => {
      const v = updateUI(e.target.value);
      clearTimeout(zscoreDebounceTimer);
      if (isLargeZScoreNetwork()) {
        zscoreDebounceTimer = setTimeout(() => applyThreshold(v), 1000);
      } else {
        applyThreshold(v);
      }
    });
    number.addEventListener("change", (e) => {
      clearTimeout(zscoreDebounceTimer);
      const v = updateUI(e.target.value);
      applyThreshold(v);
    });
  }
}

/**
 * Inspects edges of the active master network to compute min/max Z-Score bounds
 * and show or hide the Z-Score slider UI accordingly.
 * @param {Array<Object>} edgeList - Master edge array (e.g., RAW_DATA.links).
 * @param {number|null} preferredThreshold - Optional threshold override (defaults to 1.28 clamped to [min, max]).
 * @returns {boolean} True if Z-Score filtering is enabled for this network.
 */
window.configureZScoreBounds = function (edgeList, preferredThreshold = null) {
  initZScoreControls();

  let minZ = Infinity;
  let maxZ = -Infinity;
  let countWithZ = 0;

  if (Array.isArray(edgeList)) {
    for (let i = 0; i < edgeList.length; i++) {
      const e = edgeList[i];
      if (!e || e.z_score === null || e.z_score === undefined || e.z_score === "") continue;
      const z = Number(e.z_score);
      if (!Number.isFinite(z)) continue;
      countWithZ++;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  const container = document.getElementById("zscore-control-container");
  const slider = document.getElementById("zscore-slider");
  const number = document.getElementById("zscore-number");
  const display = document.getElementById("zscore-val-display");

  if (countWithZ === 0) {
    ZSCORE_STATE.enabled = false;
    ZSCORE_STATE.min = 0;
    ZSCORE_STATE.max = 1;
    ZSCORE_STATE.defaultThreshold = DEFAULT_ZSCORE_THRESHOLD;
    ZSCORE_STATE.threshold = -Infinity;
    if (container) container.style.display = "none";
    return false;
  }

  const roundedMin = Math.floor(minZ * 100) / 100;
  const roundedMax = Math.ceil(maxZ * 100) / 100;
  const effectiveMax = roundedMax > roundedMin ? roundedMax : roundedMin + 0.01;

  const baseDefault = Math.min(effectiveMax, Math.max(roundedMin, DEFAULT_ZSCORE_THRESHOLD));
  const targetVal =
    preferredThreshold !== null && Number.isFinite(Number(preferredThreshold))
      ? Math.min(effectiveMax, Math.max(roundedMin, Number(preferredThreshold)))
      : baseDefault;

  ZSCORE_STATE.enabled = true;
  ZSCORE_STATE.min = roundedMin;
  ZSCORE_STATE.max = effectiveMax;
  ZSCORE_STATE.defaultThreshold = baseDefault;
  ZSCORE_STATE.threshold = targetVal;

  if (container) container.style.display = "block";
  if (slider) {
    slider.min = String(roundedMin);
    slider.max = String(effectiveMax);
    slider.value = String(targetVal);
  }
  if (number) {
    number.min = String(roundedMin);
    number.max = String(effectiveMax);
    number.value = String(targetVal);
  }
  if (display) {
    display.innerText = targetVal.toFixed(2);
  }

  return true;
};

/**
 * Updates Z-Score threshold control values programmatically.
 * @param {number|string} val - Threshold score value.
 */
window.updateZScoreControlUI = function (val) {
  if (!ZSCORE_STATE.enabled) return;

  const slider = document.getElementById("zscore-slider");
  const number = document.getElementById("zscore-number");
  const display = document.getElementById("zscore-val-display");

  let v = parseFloat(val);
  if (!Number.isFinite(v)) v = ZSCORE_STATE.defaultThreshold;
  if (v < ZSCORE_STATE.min) v = ZSCORE_STATE.min;
  if (v > ZSCORE_STATE.max) v = ZSCORE_STATE.max;

  ZSCORE_STATE.threshold = v;
  if (slider) slider.value = String(v);
  if (number) number.value = String(v);
  if (display) display.innerText = v.toFixed(2);
};

/**
 * Loads and populates target gene text area from a user-uploaded text file.
 * @param {HTMLInputElement} input - File input element.
 */
window.loadTargetFile = function (input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function (e) {
      document.getElementById("target-input").value = e.target.result;
      window.reapplyColors();
    };
    reader.readAsText(input.files[0]);
  }
};

document.getElementById("target-input").addEventListener("input", () => {
  clearTimeout(highlightDebounce);
  highlightDebounce = setTimeout(window.reapplyColors, 500);
});

/**
 * Resets target gene inputs, Z-Score threshold (back to default), and subnetwork filters.
 */
window.clearTargets = function () {
  if (ZSCORE_STATE.enabled && typeof window.updateZScoreControlUI === "function") {
    window.updateZScoreControlUI(ZSCORE_STATE.defaultThreshold);
  }

  document.getElementById("target-input").value = "";
  document.getElementById("target-file").value = "";
  document.getElementById("target-prune").checked = false;
  document.getElementById("target-depth").value = 1;

  if (RAW_DATA.workingLinks !== null || nodes.length < RAW_DATA.nodes.length) {
    window.resetToFull();
  } else if (ZSCORE_STATE.enabled && typeof window.applyEdgeFilter === "function") {
    window.applyEdgeFilter();
  } else {
    window.reapplyColors();
  }
};

/**
 * Toggles application theme between dark and light modes.
 * @param {boolean} isLight - True if light mode selected.
 */
window.toggleTheme = function (isLight) {
  THEME = isLight ? "light" : "dark";
  if (isLight) document.body.classList.add("light-mode");
  else document.body.classList.remove("light-mode");

  const text = isLight ? "#000" : "#eee";
  const statsEl = document.getElementById("stats");
  if (statsEl) statsEl.style.color = text;
  const legendEl = document.getElementById("legend");
  if (legendEl) legendEl.style.color = text;
  const lbl = document.getElementById("tt-label");
  if (lbl) lbl.style.color = isLight ? "#000" : "#fff";

  CONFIG.visuals.colors = isLight ? { ...LIGHT_PALETTE } : { ...DARK_PALETTE };

  if (
    typeof CLUSTER_STATE !== "undefined" &&
    Array.isArray(CLUSTER_STATE.legend)
  ) {
    CLUSTER_STATE.legend.forEach((cluster, index) => {
      if (!cluster.customColor) {
        cluster.color =
          CONFIG.visuals.colors.Clusters[
            index % CONFIG.visuals.colors.Clusters.length
          ];
      }
    });
  }

  if (typeof window.reapplyColors === "function") {
    window.reapplyColors();
  } else {
    requestAnimationFrame(window.draw);
  }
};

/**
 * Triggers a fresh layout recalculation from initial node positions.
 */
window.recalculateStatic = function () {
  rng = mulberry32(_seed);
  nodes.forEach((n) => {
    n.x = undefined;
    n.y = undefined;
    n.vx = 0;
    n.vy = 0;
    n._hasLayoutPos = false;
  });
  if (window.__APP_CORE__.startCalculation) {
    window.__APP_CORE__.startCalculation(false);
  } else if (typeof startCalculation === "function") {
    startCalculation(false);
  }
};

const updateViz = () => {
  if (typeof updateVisualProps === "function") updateVisualProps();
  requestAnimationFrame(window.draw);
};

document.getElementById("viz-base-size").addEventListener("input", updateViz);
document.getElementById("viz-size-mult").addEventListener("input", updateViz);
document
  .getElementById("viz-edge-width")
  .addEventListener("input", () => requestAnimationFrame(window.draw));
document
  .getElementById("viz-edge-alpha")
  .addEventListener("input", () => requestAnimationFrame(window.draw));

const updatePhys = () => {
  if (typeof updatePhysicsParams === "function") updatePhysicsParams();
};

document.getElementById("phys-repulsion").addEventListener("input", updatePhys);
document.getElementById("phys-link-dist").addEventListener("input", updatePhys);
document.getElementById("phys-collision").addEventListener("input", updatePhys);
document.getElementById("phys-radial").addEventListener("input", updatePhys);
