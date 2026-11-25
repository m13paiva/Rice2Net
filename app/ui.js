/**
 * ui.js - User Interface & Active Stats Synchronization Module
 * 
 * Manages active node/edge counter displays and target gene match statistics.
 */

window.__APP_CORE__ = window.__APP_CORE__ || {};

/**
 * Updates the visible node and link count displays in the sidebar UI.
 */
window.updateActiveCounts = function () {
  let vNodes = 0;
  let vEdges = 0;
  const visibleSet = new Set();

  nodes.forEach((n) => {
    if (n.isDummy || String(n.id).startsWith("__dummy")) return;
    if (n.isRogue && !VISIBILITY_STATE.Rogue && !n.isTarget) return;
    if (n.color === CONFIG.visuals.colors.Transparent) return;
    vNodes++;
    visibleSet.add(n.id);
  });

  links.forEach((l) => {
    const s = l.source?.id || l.source;
    const t = l.target?.id || l.target;
    if (visibleSet.has(s) && visibleSet.has(t)) {
      if (window.isEdgeVisible ? window.isEdgeVisible(l) : true) vEdges++;
    }
  });

  const nEl = document.getElementById("val-nodes");
  const eEl = document.getElementById("val-edges");
  if (nEl) nEl.innerText = vNodes.toLocaleString();
  if (eEl) eEl.innerText = vEdges.toLocaleString();
};

/**
 * Renders target gene match statistics in the sidebar UI.
 * @param {number} found - Number of target genes matched in active view.
 * @param {number} total - Total target genes specified.
 */
function updateTargetStats(found, total) {
  const statsContainer = document.getElementById("stats");
  if (!statsContainer) return;

  let targetStat = document.getElementById("val-targets");
  if (!targetStat) {
    targetStat = document.createElement("div");
    targetStat.id = "val-targets";
    targetStat.style.marginTop = "4px";
    targetStat.style.fontSize = "0.85rem";
    targetStat.style.opacity = "0.9";
    statsContainer.appendChild(targetStat);
  }

  if (total > 0) {
    targetStat.style.display = "block";
    targetStat.innerHTML = `<span style="color:${CONFIG.visuals.colors.Green}; font-weight:bold;">${found}</span> / ${total} targets found`;
  } else {
    targetStat.style.display = "none";
  }
}

/**
 * Evaluates active target gene inputs and updates sidebar match counts.
 */
window.updateTargetCounts = function () {
  const text = document.getElementById("target-input")?.value || "";
  if (!text.trim()) {
    updateTargetStats(0, 0);
    return;
  }

  const rawTargets = window.parseRawTargets
    ? window.parseRawTargets(text)
    : text.split(/[\r\n,\t]+/).map((s) => s.trim()).filter(Boolean);
  const targetSet = window.resolveTargetIds
    ? window.resolveTargetIds(rawTargets)
    : new Set(rawTargets);

  let found = 0;
  const counted = new Set();
  const searchPool = (RAW_DATA && Array.isArray(RAW_DATA.nodes) && RAW_DATA.nodes.length > 0) ? RAW_DATA.nodes : nodes;
  searchPool.forEach((n) => {
    if (!n || n.isDummy) return;
    const id = String(n.id);
    if (id.startsWith("__dummy")) return;
    if (targetSet.has(id) && !counted.has(id)) {
      counted.add(id);
      found++;
    }
  });

  updateTargetStats(found, rawTargets.length);
};

/**
 * Initializes the non-intrusive Web Demo Mode badge and custom import notice helpers.
 */
function initDemoModeUI() {
  if (!window.RICE2NET_API || !window.RICE2NET_API.isDemoMode || !window.RICE2NET_API.isDemoMode()) {
    return;
  }

  if (!document.getElementById("demo-badge")) {
    const container = document.getElementById("container") || document.body;
    const badge = document.createElement("div");
    badge.id = "demo-badge";
    badge.innerHTML = `
      <span class="demo-badge-dot"></span>
      <span class="demo-badge-text">Web Demo (Curated Subnetwork)</span>
      <span class="demo-badge-sep"></span>
      <a class="demo-badge-link" href="https://github.com/m13paiva/Rice2Net/releases" target="_blank" rel="noopener noreferrer"
         title="Full 46,036-gene genome annotations &amp; offline causality analysis available in the Desktop App">
        Get Desktop App &nearr;
      </a>
    `;
    container.appendChild(badge);
  }
}

window.showDemoImportNotice = function () {
  if (!window.RICE2NET_API || !window.RICE2NET_API.isDemoMode || !window.RICE2NET_API.isDemoMode()) {
    return;
  }
  const container = document.getElementById("container") || document.body;
  let toast = document.getElementById("demo-import-notice");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "demo-import-notice";
    toast.innerHTML = `
      <span>
        <strong>Web Demo Import:</strong> Gene annotation lookup and motif causality are limited to the curated demo genes.
        <a href="https://github.com/m13paiva/Rice2Net/releases" target="_blank" rel="noopener noreferrer">Get the Desktop App</a>
        for full 46,036-gene annotations &amp; genome-wide offline causality.
      </span>
      <button type="button" class="demo-notice-close" onclick="window.hideDemoImportNotice()" title="Dismiss">&times;</button>
    `;
    container.appendChild(toast);
  }
  toast.style.display = "flex";
};

window.hideDemoImportNotice = function () {
  const toast = document.getElementById("demo-import-notice");
  if (toast) toast.style.display = "none";
};

initDemoModeUI();

if (typeof window.__APP_CORE__.main === 'function') {
  window.__APP_CORE__.main();
}
