// controls.js
function initIRPControls() {
  const targetInput = document.getElementById("target-input");
  if (targetInput && !document.getElementById("irp-control-container")) {
    const container = document.createElement("div");
    container.id = "irp-control-container";
    container.style.marginTop = "15px";
    container.style.paddingTop = "10px";
    container.style.borderTop = "1px solid #444";
    container.style.pointerEvents = "auto";

    container.innerHTML = `
      <div style="font-size:0.85rem; color:#bbb; margin-bottom:5px; display:flex; justify-content:space-between;">
        <span>IRP SCORE THRESHOLD</span>
        <span id="irp-val-display" style="color:#fff;">0.00</span>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <input type="range" id="irp-slider" min="0" max="1" step="0.01" value="0" style="flex:1;">
        <input type="number" id="irp-number" min="0" max="1" step="0.01" value="0" style="width:60px; background:#222; border:1px solid #555; color:#eee; padding:2px 4px; border-radius:3px;">
      </div>
    `;

    targetInput.parentNode.appendChild(container);

    const slider = document.getElementById("irp-slider");
    const number = document.getElementById("irp-number");
    const display = document.getElementById("irp-val-display");

    function update(val) {
      let v = parseFloat(val);
      if (isNaN(v)) v = 0;
      if (v > 1) v = 1;
      if (v < 0) v = 0;

      IRP_STATE.threshold = v;
      slider.value = v;
      number.value = v;
      display.innerText = v.toFixed(2);

      if (typeof window.applyEdgeFilter === "function") {
        window.applyEdgeFilter();
      }
    }

    slider.addEventListener("input", (e) => update(e.target.value));
    number.addEventListener("change", (e) => update(e.target.value));
  }
}

window.updateIRPControlUI = function (val) {
  const slider = document.getElementById("irp-slider");
  const number = document.getElementById("irp-number");
  const display = document.getElementById("irp-val-display");

  if (slider && number && display) {
    slider.value = val;
    number.value = val;
    display.innerText = parseFloat(val).toFixed(2);
    IRP_STATE.threshold = parseFloat(val);
  }
};

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

window.clearTargets = function () {
  if (typeof window.updateIRPControlUI === "function") {
    window.updateIRPControlUI(0);
  }

  document.getElementById("target-input").value = "";
  document.getElementById("target-file").value = "";
  document.getElementById("target-prune").checked = false;
  document.getElementById("target-depth").value = 1;

  if (nodes.length < RAW_DATA.nodes.length) window.resetToFull();
  else window.reapplyColors();
};

window.toggleTheme = function (isLight) {
  THEME = isLight ? "light" : "dark";

  // By omitting document.body.classList.add("light-mode"), the entire UI remains locked into
  // its original CSS dark mode state. The canvas visual logic naturally handles the light background.

  const text = isLight ? "#333" : "#eee";
  if (document.getElementById("stats"))
    document.getElementById("stats").style.color = text;
  if (document.getElementById("legend"))
    document.getElementById("legend").style.color = text;
  const lbl = document.getElementById("tt-label");
  if (lbl) lbl.style.color = isLight ? "#000" : "#fff";

  CONFIG.visuals.colors = isLight ? { ...LIGHT_PALETTE } : { ...DARK_PALETTE };

  if (
    typeof CLUSTER_STATE !== "undefined" &&
    Array.isArray(CLUSTER_STATE.legend)
  ) {
    CLUSTER_STATE.legend.forEach((cluster, index) => {
      cluster.color =
        CONFIG.visuals.colors.Clusters[
          index % CONFIG.visuals.colors.Clusters.length
        ];
    });
  }

  if (typeof window.reapplyColors === "function") {
    window.reapplyColors();
  } else {
    requestAnimationFrame(window.draw);
  }
};

window.recalculateStatic = function () {
  nodes.forEach((n) => {
    n.x = undefined;
    n.y = undefined;
    n.vx = 0;
    n.vy = 0;
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
