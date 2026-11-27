/**
 * analyze.js - Community Discovery (Infomap + ORA), ORA Report Modal,
 * and Promoter-Binding Motifs Controller
 *
 * Orchestrates:
 *  - Running Infomap community detection + Hypergeometric ORA (BH-FDR) on visible graph
 *  - Running ORA-only re-analysis on imported networks with saved cluster metadata
 *  - Interactive cluster management (rename, recolor, delete, clear, TSV export)
 *  - ORA report modal with horizontal Fold bar charts and lazy gene-overlap expansion
 *  - Promoter-Binding Motifs source-filtered regulation discovery & legend visibility
 */

(function () {
  let activeOraClusterId = null;
  let activeOraSourceFilter = "ALL";
  let isOraModalOpen = false;

  // Multi-parameter ORA sort chain (primary -> secondary -> tertiary)
  const ORA_SORT_FIELDS = [
    { key: "pAdj", label: "Adj. p (FDR)", defaultDir: "asc" },
    { key: "pValue", label: "p-value", defaultDir: "asc" },
    { key: "foldEnrichment", label: "Fold", defaultDir: "desc" },
    { key: "overlap", label: "Overlap (k)", defaultDir: "desc" },
    { key: "termSize", label: "Term Size (M)", defaultDir: "asc" },
    { key: "source", label: "Source", defaultDir: "asc" },
    { key: "termId", label: "Term ID", defaultDir: "asc" },
    { key: "name", label: "Description", defaultDir: "asc" },
  ];

  let oraSortCriteria = [
    { key: "pAdj", dir: "asc" },
    { key: "foldEnrichment", dir: "desc" },
    { key: "overlap", dir: "desc" },
  ];

  function getSortFieldDefaultDir(key) {
    const f = ORA_SORT_FIELDS.find((x) => x.key === key);
    return f ? f.defaultDir : "asc";
  }

  function compareOraTerms(a, b) {
    for (let i = 0; i < oraSortCriteria.length; i++) {
      const crit = oraSortCriteria[i];
      if (!crit || !crit.key || crit.key === "none") continue;
      const mult = crit.dir === "desc" ? -1 : 1;
      const k = crit.key;
      const va = a ? a[k] : null;
      const vb = b ? b[k] : null;

      let cmp = 0;
      if (k === "source" || k === "termId" || k === "name") {
        cmp = String(va || "").localeCompare(String(vb || ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      } else {
        const na = Number(va);
        const nb = Number(vb);
        const fa = Number.isFinite(na) ? na : 0;
        const fb = Number.isFinite(nb) ? nb : 0;
        cmp = fa < fb ? -1 : fa > fb ? 1 : 0;
      }

      if (cmp !== 0) return cmp * mult;
    }
    return 0;
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) =>
      l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
  }

  function pickClusterColor(index) {
    const palette =
      (CONFIG &&
        CONFIG.visuals &&
        CONFIG.visuals.colors &&
        CONFIG.visuals.colors.Clusters) ||
      [];
    if (index < palette.length) return palette[index];
    const hue = Math.round(((index * 137.508) + 25) % 360);
    const light = THEME === "light" ? 42 : 58;
    return hslToHex(hue, 78, light);
  }

  /**
   * Maps a normalized fold ratio [0..1] to a continuous color scale:
   * light green near 0 -> warm yellow -> deep orange -> dark red at high fold.
   */
  function foldRatioToColor(ratio) {
    const t = Math.max(0, Math.min(1, Number(ratio) || 0));
    const stops = [
      { pos: 0.0, rgb: [168, 230, 163] },  // Light green (#A8E6A3)
      { pos: 0.35, rgb: [244, 211, 94] },  // Warm yellow (#F4D35E)
      { pos: 0.7, rgb: [224, 109, 43] },   // Orange-red (#E06D2B)
      { pos: 1.0, rgb: [139, 0, 0] },      // Dark red (#8B0000)
    ];

    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (t >= a.pos && t <= b.pos) {
        const local = (t - a.pos) / (b.pos - a.pos || 1);
        const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * local);
        const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * local);
        const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * local);
        return `rgb(${r}, ${g}, ${bl})`;
      }
    }
    return "rgb(139, 0, 0)";
  }

  function formatPValue(p) {
    if (p === null || p === undefined || !Number.isFinite(p)) return "-";
    if (p === 0) return "< 1e-300";
    if (p < 0.001) return p.toExponential(2);
    return p.toFixed(4);
  }

  function formatBackgroundLabel(bg) {
    if (!bg) return "";
    const modeLabel =
      bg.mode === "none"
        ? "No background (full genome)"
        : bg.mode === "custom"
        ? `Custom list (${(bg.rawBackgroundSize || 0).toLocaleString()} genes)`
        : `Visible network (${(bg.rawBackgroundSize || 0).toLocaleString()} genes)`;
    const scopeLabel = bg.annotatedOnly ? "annotated only" : "all genes";
    return `${modeLabel}, ${scopeLabel}`;
  }

  window.onBackgroundModeChange = function (mode) {
    const wrap = document.getElementById("cd-bg-custom-wrap");
    if (!wrap) return;
    wrap.style.display = mode === "custom" ? "block" : "none";
  };

  window.loadBackgroundFile = function (input) {
    if (input && input.files && input.files[0]) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const box = document.getElementById("cd-bg-input");
        if (box) box.value = e.target.result || "";
      };
      reader.readAsText(input.files[0]);
    }
  };

  /**
   * Extracts strictly the currently displayed (visible) nodes and visible edges from the graph.
   */
  function extractVisibleSubgraph() {
    const visibleNodes = [];
    const idToIdx = new Map();

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || n.isDummy || String(n.id).startsWith("__dummy")) continue;
      if (n.isRogue && !VISIBILITY_STATE.Rogue && !n.isTarget) continue;
      if (n.color === CONFIG.visuals.colors.Transparent) continue;
      const id = String(n.id);
      if (!idToIdx.has(id)) {
        idToIdx.set(id, visibleNodes.length);
        visibleNodes.push(id);
      }
    }

    const visibleEdges = [];
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (window.isEdgeVisible && !window.isEdgeVisible(l)) continue;
      const sId = String(l.source?.id || l.source);
      const tId = String(l.target?.id || l.target);
      const sIdx = idToIdx.get(sId);
      const tIdx = idToIdx.get(tId);
      if (sIdx === undefined || tIdx === undefined || sIdx === tIdx) continue;
      const rawW =
        l.weight !== undefined && l.weight !== null
          ? Number(l.weight)
          : l.value !== undefined && l.value !== null
          ? Number(l.value)
          : 1;
      visibleEdges.push([sIdx, tIdx, Number.isFinite(rawW) ? rawW : 1]);
    }

    return { visibleNodes, visibleEdges };
  }

  /**
   * Synchronizes the Analyze -> Community Discovery status summary card.
   */
  window.updateCommunityDiscoverySummary = function (customMessage = null, variant = "normal") {
    const panel = document.getElementById("cd-results-panel");
    const summaryEl = document.getElementById("cd-status-summary");
    if (!panel || !summaryEl) return;

    summaryEl.classList.remove("cd-status-empty", "cd-status-error");

    if (customMessage) {
      panel.style.display = "block";
      if (variant === "empty") summaryEl.classList.add("cd-status-empty");
      if (variant === "error") summaryEl.classList.add("cd-status-error");
      summaryEl.innerHTML = customMessage;
      const viewBtn = panel.querySelector(".btn-export");
      const clearBtn = panel.querySelector(".btn-clear");
      const hasClusters = CLUSTER_STATE.legend.length > 0;
      if (viewBtn) viewBtn.style.display = hasClusters ? "block" : "none";
      if (clearBtn) clearBtn.style.display = hasClusters ? "block" : "none";
      return;
    }

    if (!CLUSTER_STATE.source || CLUSTER_STATE.legend.length === 0) {
      panel.style.display = "none";
      return;
    }

    panel.style.display = "block";
    const stats = CLUSTER_STATE.lastStats || {};
    const kept = CLUSTER_STATE.legend.length;
    const totalMods = stats.totalModulesDetected ?? kept;
    const bgText = formatBackgroundLabel(stats.background);
    const pThr = stats.pvalThreshold ?? 0.05;
    const mt = stats.markovTime;

    const sourceTag =
      CLUSTER_STATE.source === "db"
        ? "Reference network clusters"
        : CLUSTER_STATE.source === "imported"
        ? "Imported clusters (ORA refreshed)"
        : `from ${totalMods} Infomap modules`;

    const mtPart = mt !== undefined && mt !== null ? `Markov time: ${escapeHtml(mt)} &middot; ` : "";

    summaryEl.innerHTML = `
      <div><strong>${kept}</strong> cluster${kept === 1 ? "" : "s"} active <span style="opacity:0.75;">(${escapeHtml(sourceTag)})</span></div>
      <div style="font-size:0.74rem; opacity:0.8; margin-top:4px;">
        ${mtPart}FDR &le; ${escapeHtml(pThr)}${bgText ? `<br/>${escapeHtml(bgText)}` : ""}
      </div>
    `;

    const viewBtn = panel.querySelector(".btn-export");
    const clearBtn = panel.querySelector(".btn-clear");
    if (viewBtn) viewBtn.style.display = "block";
    if (clearBtn) clearBtn.style.display = "block";
  };

  /**
   * Executes Community Discovery (Infomap + ORA) on the currently displayed visible graph.
   */
  window.runCommunityDiscoveryUI = async function () {
    const markovInput = document.getElementById("cd-markov-time");
    const bgModeSelect = document.getElementById("cd-bg-mode");
    const bgCustomInput = document.getElementById("cd-bg-input");
    const scopeAnnotatedRadio = document.getElementById("cd-scope-annotated");
    const pvalInput = document.getElementById("cd-pval-threshold");
    const runBtn = document.getElementById("cd-run-btn");

    const markovTime = parseFloat(markovInput ? markovInput.value : "1");
    const backgroundMode = bgModeSelect ? bgModeSelect.value : "network";
    const annotatedOnly = scopeAnnotatedRadio ? scopeAnnotatedRadio.checked : true;
    const pvalThreshold = parseFloat(pvalInput ? pvalInput.value : "0.05");

    if (!Number.isFinite(markovTime) || markovTime <= 0 || markovTime > 100) {
      window.updateCommunityDiscoverySummary(
        "Markov time must be a positive number (e.g. 1).",
        "error"
      );
      return;
    }

    if (!Number.isFinite(pvalThreshold) || pvalThreshold <= 0 || pvalThreshold > 1) {
      window.updateCommunityDiscoverySummary(
        "Adjusted p-value threshold must be between 0 and 1 (e.g. 0.05).",
        "error"
      );
      return;
    }

    let customBackground = [];
    if (backgroundMode === "custom") {
      const rawText = bgCustomInput ? bgCustomInput.value : "";
      customBackground = window.parseRawTargets
        ? window.parseRawTargets(rawText)
        : rawText
            .split(/[\r\n,\t\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
      if (customBackground.length === 0) {
        window.updateCommunityDiscoverySummary(
          "Please enter or import at least one gene in the Custom list background.",
          "error"
        );
        return;
      }
    }

    const { visibleNodes, visibleEdges } = extractVisibleSubgraph();
    if (visibleNodes.length < 2 || visibleEdges.length < 1) {
      window.updateCommunityDiscoverySummary(
        "At least 2 visible nodes and 1 visible edge are required to run Community Discovery.",
        "error"
      );
      return;
    }

    const loader = document.getElementById("loader");
    const loaderText = document.getElementById("loader-text");
    const progressBar = document.getElementById("progress-bar");

    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = "RUNNING...";
    }
    if (document.body && document.body.classList) {
      document.body.classList.add("is-loading");
    }
    if (loader) loader.style.display = "block";
    if (loaderText) {
      loaderText.innerText = `RUNNING COMMUNITY DISCOVERY & ORA (${visibleNodes.length.toLocaleString()} GENES)...`;
    }
    if (progressBar) progressBar.style.width = "45%";

    try {
      const response = await window.RICE2NET_API.runCommunityDiscovery({
        nodes: visibleNodes,
        edges: visibleEdges,
        markovTime,
        backgroundMode,
        customBackground,
        annotatedOnly,
        pvalThreshold,
      });

      if (progressBar) progressBar.style.width = "100%";

      const discovered = Array.isArray(response.clusters) ? response.clusters : [];
      CLUSTER_STATE.data.clear();
      CLUSTER_STATE.active.clear();
      CLUSTER_STATE.legend = [];
      CLUSTER_STATE.byId.clear();
      CLUSTER_STATE.source = "discovered";
      CLUSTER_STATE.lastStats = response.stats || null;

      discovered.forEach((c, idx) => {
        const id = String(c.id || `cd_${idx + 1}`);
        const color = pickClusterColor(idx);
        const clusterObj = {
          id,
          moduleId: c.moduleId,
          name: c.name || `Cluster ${idx + 1}`,
          color,
          customColor: false,
          count: Array.isArray(c.genes) ? c.genes.length : c.size || 0,
          genes: Array.isArray(c.genes) ? c.genes.map(String) : [],
          topTerm: c.topTerm || null,
          termsCount: c.termsCount || (Array.isArray(c.terms) ? c.terms.length : 0),
          terms: Array.isArray(c.terms) ? c.terms : [],
        };
        CLUSTER_STATE.legend.push(clusterObj);
        CLUSTER_STATE.byId.set(id, clusterObj);
        CLUSTER_STATE.active.add(id);
        clusterObj.genes.forEach((gid) => {
          CLUSTER_STATE.data.set(String(gid), id);
        });
      });

      window.CLUSTERS_ENABLED = discovered.length > 0;
      if (typeof window.updateClusterAvailability === "function") {
        window.updateClusterAvailability();
      }
      if (typeof window.reapplyColors === "function") {
        window.reapplyColors();
      }

      if (discovered.length > 0) {
        const legendClusters = document.getElementById("legend-clusters");
        const det = legendClusters ? legendClusters.querySelector("details") : null;
        if (det) det.setAttribute("open", "");
        window.updateCommunityDiscoverySummary();
      } else {
        const totalMods = response.stats?.totalModulesDetected ?? 0;
        window.updateCommunityDiscoverySummary(
          `No clusters passed the adjusted p-value threshold (&le; ${escapeHtml(
            pvalThreshold
          )}) out of ${totalMods} Infomap module${totalMods === 1 ? "" : "s"}. Try adjusting Markov time, background scope, or p-value threshold.`,
          "empty"
        );
      }
    } catch (err) {
      console.error("Community Discovery failed:", err);
      window.updateCommunityDiscoverySummary(
        escapeHtml(err.message || "Community Discovery failed."),
        "error"
      );
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = "GO";
      }
      if (loader) loader.style.display = "none";
      if (document.body && document.body.classList) {
        document.body.classList.remove("is-loading");
      }
    }
  };

  /**
   * Loads clusters restored from an imported JSON or TSV file and runs ORA-only
   * re-analysis against the imported network using the saved adjusted p-value threshold.
   */
  window.loadImportedClustersAndRunOra = async function (clusterBundle) {
    if (!clusterBundle || !Array.isArray(clusterBundle.items) || clusterBundle.items.length === 0) {
      return;
    }

    const pvalThreshold =
      Number.isFinite(Number(clusterBundle.pvalThreshold)) &&
      Number(clusterBundle.pvalThreshold) > 0 &&
      Number(clusterBundle.pvalThreshold) <= 1
        ? Number(clusterBundle.pvalThreshold)
        : 0.05;
    const backgroundMode =
      clusterBundle.backgroundMode === "none" ? "none" : "network";
    const annotatedOnly =
      clusterBundle.annotatedOnly !== undefined ? Boolean(clusterBundle.annotatedOnly) : true;
    const markovTime =
      Number.isFinite(Number(clusterBundle.markovTime)) && Number(clusterBundle.markovTime) > 0
        ? Number(clusterBundle.markovTime)
        : null;

    // Sync Community Discovery UI inputs with the imported settings
    const pvalInput = document.getElementById("cd-pval-threshold");
    if (pvalInput) pvalInput.value = pvalThreshold;
    const bgSelect = document.getElementById("cd-bg-mode");
    if (bgSelect) {
      bgSelect.value = backgroundMode;
      window.onBackgroundModeChange(backgroundMode);
    }
    const scopeAnn = document.getElementById("cd-scope-annotated");
    const scopeAll = document.getElementById("cd-scope-all");
    if (scopeAnn && scopeAll) {
      scopeAnn.checked = annotatedOnly;
      scopeAll.checked = !annotatedOnly;
    }
    if (markovTime !== null) {
      const mtInput = document.getElementById("cd-markov-time");
      if (mtInput) mtInput.value = markovTime;
    }

    // Build lookup from imported node IDs (and RAP/MSU aliases) -> active canvas node ID
    const aliasToNodeId = new Map();
    const activeNodeIds = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || n.isDummy || String(n.id).startsWith("__dummy")) continue;
      const nid = String(n.id);
      activeNodeIds.push(nid);
      aliasToNodeId.set(nid.toLowerCase(), nid);
      if (n.rap_id) aliasToNodeId.set(String(n.rap_id).toLowerCase(), nid);
      if (n.msu_id) {
        const m = String(n.msu_id).toLowerCase();
        aliasToNodeId.set(m, nid);
        aliasToNodeId.set(m.replace(/\.\d+$/, ""), nid);
      }
    }

    // Populate CLUSTER_STATE immediately so clusters appear right away
    CLUSTER_STATE.data.clear();
    CLUSTER_STATE.active.clear();
    CLUSTER_STATE.legend = [];
    CLUSTER_STATE.byId.clear();
    CLUSTER_STATE.source = "imported";

    const preparedForOra = [];
    clusterBundle.items.forEach((raw, idx) => {
      const id = String(raw.id || `imp_${idx + 1}`);
      const name = String(raw.name || `Cluster ${idx + 1}`).trim();
      const color = raw.color || pickClusterColor(idx);
      const geneSet = new Set();
      (raw.genes || []).forEach((g) => {
        const key = String(g || "").trim().toLowerCase();
        if (!key) return;
        const resolved = aliasToNodeId.get(key) || aliasToNodeId.get(key.replace(/\.\d+$/, ""));
        if (resolved) geneSet.add(resolved);
      });

      if (geneSet.size === 0) return;

      const geneList = Array.from(geneSet);
      const entry = {
        id,
        name,
        color,
        customColor: true,
        count: geneList.length,
        genes: geneList,
        topTerm: null,
        termsCount: 0,
        terms: [],
      };
      CLUSTER_STATE.legend.push(entry);
      CLUSTER_STATE.byId.set(id, entry);
      CLUSTER_STATE.active.add(id);
      geneList.forEach((gid) => CLUSTER_STATE.data.set(gid, id));

      preparedForOra.push({
        id,
        name,
        color,
        customColor: true,
        genes: geneList,
      });
    });

    if (CLUSTER_STATE.legend.length === 0) {
      CLUSTER_STATE.source = null;
      window.CLUSTERS_ENABLED = false;
      if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();
      return;
    }

    CLUSTER_STATE.lastStats = {
      totalModulesDetected: CLUSTER_STATE.legend.length,
      enrichedClustersCount: 0,
      markovTime,
      pvalThreshold,
      background: {
        mode: backgroundMode,
        annotatedOnly,
        rawBackgroundSize: activeNodeIds.length,
      },
    };

    window.CLUSTERS_ENABLED = true;
    if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();
    if (typeof window.reapplyColors === "function") window.reapplyColors();
    window.updateCommunityDiscoverySummary();

    // Run ORA-only on the imported clusters via backend
    if (window.RICE2NET_API && !window.RICE2NET_API.isDemoMode()) {
      const loader = document.getElementById("loader");
      const loaderText = document.getElementById("loader-text");
      const progressBar = document.getElementById("progress-bar");
      const wasHidden = !loader || loader.style.display === "none";

      if (wasHidden && loader) {
        loader.style.display = "block";
        if (loaderText) loaderText.innerText = "RUNNING ORA ON IMPORTED CLUSTERS...";
        if (progressBar) progressBar.style.width = "60%";
      }

      try {
        const res = await window.RICE2NET_API.runOra({
          nodes: activeNodeIds,
          clusters: preparedForOra,
          backgroundMode,
          annotatedOnly,
          pvalThreshold,
        });

        if (res && Array.isArray(res.clusters)) {
          res.clusters.forEach((rc) => {
            const target = CLUSTER_STATE.byId.get(String(rc.id));
            if (!target) return;
            target.terms = Array.isArray(rc.terms) ? rc.terms : [];
            target.termsCount = target.terms.length;
            target.topTerm = target.terms.length > 0 ? target.terms[0] : null;
          });
          if (res.stats) {
            CLUSTER_STATE.lastStats = {
              ...res.stats,
              markovTime,
            };
          }
          if (typeof window.renderClusterLegend === "function") window.renderClusterLegend();
          window.updateCommunityDiscoverySummary();
        }
      } catch (err) {
        console.warn("ORA re-analysis on imported clusters failed:", err);
      } finally {
        if (wasHidden && loader) loader.style.display = "none";
      }
    }
  };

  /**
   * Renames a cluster by ID and syncs canvas, legend, and open ORA modal.
   */
  window.renameCluster = function (clusterId, newName) {
    const cluster = CLUSTER_STATE.byId.get(String(clusterId));
    if (!cluster) return;
    const cleaned = String(newName || "").trim();
    if (!cleaned) {
      if (typeof window.renderClusterLegend === "function") window.renderClusterLegend();
      return;
    }
    cluster.name = cleaned;
    if (typeof window.reapplyColors === "function") window.reapplyColors();
    if (isOraModalOpen) renderOraModalContent();
  };

  /**
   * Live-updates a cluster's color on the canvas and swatches without tearing down
   * an open native <input type="color"> picker dialog.
   */
  window.setClusterColor = function (clusterId, hexColor, commit = true) {
    const id = String(clusterId);
    const cluster = CLUSTER_STATE.byId.get(id);
    if (!cluster || !hexColor) return;
    cluster.color = String(hexColor);
    cluster.customColor = true;

    document
      .querySelectorAll(`[data-cluster-color-id="${id}"]`)
      .forEach((el) => {
        if (el.tagName === "INPUT") {
          if (el.value.toLowerCase() !== cluster.color.toLowerCase()) {
            el.value = cluster.color;
          }
        } else {
          el.style.background = cluster.color;
        }
      });

    if (commit) {
      if (typeof window.reapplyColors === "function") window.reapplyColors();
      if (isOraModalOpen) renderOraModalContent();
    } else {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || n.isTarget) continue;
        if (CLUSTER_STATE.data.get(String(n.id)) !== id) continue;
        if (!CLUSTER_STATE.active.has(id)) continue;
        const baseSpec = window.getTypeVisualSpec
          ? window.getTypeVisualSpec(n.originalType || "Gene")
          : { visibilityKey: "Gene" };
        if (
          baseSpec.visibilityKey === "Gene" ||
          baseSpec.visibilityKey === "AnnotatedGene"
        ) {
          n.color = cluster.color;
          n.strokeColor = cluster.color;
          if (!n.hollow) n.fillColor = cluster.color;
        }
      }
      if (typeof window.draw === "function") requestAnimationFrame(window.draw);
    }
  };

  /**
   * Deletes a single cluster (underlying nodes remain visible with default type styling).
   */
  window.deleteCluster = function (clusterId) {
    const id = String(clusterId);
    const cluster = CLUSTER_STATE.byId.get(id);
    if (!cluster) return;

    CLUSTER_STATE.byId.delete(id);
    CLUSTER_STATE.active.delete(id);
    CLUSTER_STATE.legend = CLUSTER_STATE.legend.filter((c) => c.id !== id);

    for (const [geneId, assignedId] of CLUSTER_STATE.data.entries()) {
      if (assignedId === id) CLUSTER_STATE.data.delete(geneId);
    }

    if (CLUSTER_STATE.legend.length === 0) {
      window.CLUSTERS_ENABLED = false;
      CLUSTER_STATE.source = null;
      if (isOraModalOpen && typeof window.closeDetails === "function") {
        window.closeDetails();
      }
    } else if (activeOraClusterId === id) {
      activeOraClusterId = CLUSTER_STATE.legend[0].id;
    }

    if (typeof window.updateClusterAvailability === "function") {
      window.updateClusterAvailability();
    }
    if (typeof window.reapplyColors === "function") {
      window.reapplyColors();
    }
    window.updateCommunityDiscoverySummary();
    if (isOraModalOpen && CLUSTER_STATE.legend.length > 0) {
      renderOraModalContent();
    }
  };

  /**
   * Resets all in-memory cluster state cleanly (used on import, revert, or manual clear).
   */
  window.resetClustersState = function () {
    CLUSTER_STATE.data.clear();
    CLUSTER_STATE.active.clear();
    CLUSTER_STATE.legend = [];
    CLUSTER_STATE.byId.clear();
    CLUSTER_STATE.source = null;
    CLUSTER_STATE.lastStats = null;
    CLUSTER_STATE.isAvailable = false;
    activeOraClusterId = null;

    if (isOraModalOpen && typeof window.closeDetails === "function") {
      window.closeDetails();
    }
    window.updateCommunityDiscoverySummary();
  };

  /**
   * Clears all active clusters and restores default network styling.
   */
  window.clearDiscoveredClusters = function () {
    window.resetClustersState();
    window.CLUSTERS_ENABLED = false;

    if (typeof window.updateClusterAvailability === "function") {
      window.updateClusterAvailability();
    }
    if (typeof window.reapplyColors === "function") {
      window.reapplyColors();
    }
  };

  /**
   * Exports ORA results (for one cluster or all active clusters) as a TSV file.
   */
  window.exportClusterOraTSV = function (clusterId = null) {
    const targets = clusterId
      ? [CLUSTER_STATE.byId.get(String(clusterId))].filter(Boolean)
      : CLUSTER_STATE.legend;

    if (!targets || targets.length === 0) return;

    const headers = [
      "Cluster_ID",
      "Cluster_Name",
      "Cluster_Size",
      "Source",
      "Term_ID",
      "Term_Name",
      "Overlap",
      "Query_Size",
      "Term_Size",
      "Background_Size",
      "P_Value",
      "P_Adjusted_BH",
      "Fold",
      "Overlap_Genes",
    ];
    const rows = [headers.join("\t")];

    targets.forEach((c) => {
      const sortedTerms = [...(c.terms || [])].sort(compareOraTerms);
      sortedTerms.forEach((t) => {
        rows.push(
          [
            c.id,
            String(c.name || "").replace(/\t|\r|\n/g, " "),
            c.count,
            t.source,
            t.termId,
            String(t.name || "").replace(/\t|\r|\n/g, " "),
            t.overlap,
            t.querySize,
            t.termSize,
            t.backgroundSize,
            t.pValue,
            t.pAdj,
            t.foldEnrichment,
            Array.isArray(t.genes) ? t.genes.join(",") : "",
          ].join("\t")
        );
      });
    });

    const blob = new Blob([rows.join("\n")], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = clusterId
      ? `cluster_${clusterId}_ora.tsv`
      : "community_discovery_ora.tsv";
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Exports the gene list of a specific cluster as a TSV file.
   */
  window.exportClusterGenesTSV = function (clusterId) {
    const cluster = CLUSTER_STATE.byId.get(String(clusterId));
    if (!cluster) return;

    const pvalThreshold =
      (CLUSTER_STATE.lastStats && CLUSTER_STATE.lastStats.pvalThreshold) ??
      (parseFloat(document.getElementById("cd-pval-threshold")?.value) || 0.05);

    const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
    const rows = [
      "Gene_ID\tRAP_ID\tMSU_ID\tIdentifier\tSymbol\tType\tCluster_ID\tCluster_Name\tCluster_Color\tCluster_Pval_Threshold",
    ];
    cluster.genes.forEach((gid) => {
      const n = nodeMap.get(String(gid));
      const exportId = n && window.getExportNodeId ? window.getExportNodeId(n) : gid;
      rows.push(
        [
          exportId,
          (n && (n.rap_id || n.id)) || gid,
          (n && n.msu_id) || "",
          (n && n.identifier) || "",
          (n && n.symbol) || "",
          (n && n.originalType) || "Gene",
          cluster.id,
          String(cluster.name || "").replace(/\t|\r|\n/g, " "),
          cluster.color || "",
          pvalThreshold,
        ].join("\t")
      );
    });

    const blob = new Blob([rows.join("\n")], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cluster_${cluster.id}_genes.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  function getTermLinkHtml(term) {
    const tid = escapeHtml(term.termId);
    if (term.source && term.source.startsWith("GO:")) {
      return `<a href="https://www.ebi.ac.uk/QuickGO/term/${encodeURIComponent(
        term.termId
      )}" target="_blank" style="color:#4db8ff; text-decoration:none; font-family:monospace;">${tid}</a>`;
    }
    if (term.source === "KEGG" && term.termId) {
      return `<a href="https://www.genome.jp/entry/${encodeURIComponent(
        term.termId
      )}" target="_blank" style="color:#4db8ff; text-decoration:none; font-family:monospace;">${tid}</a>`;
    }
    return `<span style="font-family:monospace; color:#4db8ff;">${tid}</span>`;
  }

  function renderGeneLinksHtml(geneList) {
    if (!Array.isArray(geneList) || geneList.length === 0) {
      return `<span style="opacity:0.6; font-size:0.76rem;">No overlapping genes resolved.</span>`;
    }
    const geneLinks = geneList
      .slice(0, 60)
      .map(
        (gid) =>
          `<span style="font-family:monospace; font-size:0.78rem; color:#4db8ff; cursor:pointer; margin-right:6px;" onclick="window.inspectGeneFromOra('${escapeHtml(
            gid
          )}')">${escapeHtml(gid)}</span>`
      )
      .join("");
    const moreNote =
      geneList.length > 60
        ? `<span style="opacity:0.6; font-size:0.75rem;">+${geneList.length - 60} more</span>`
        : "";
    return geneLinks + moreNote;
  }

  /**
   * Lazily fetches overlap gene IDs for DB-loaded cluster terms on first <details> toggle.
   */
  window.loadTermOverlapGenes = async function (clusterId, termIdx, detailsEl) {
    if (!detailsEl || !detailsEl.open) return;
    const cluster = CLUSTER_STATE.byId.get(String(clusterId));
    if (!cluster || !Array.isArray(cluster.terms)) return;
    const term = cluster.terms[termIdx];
    if (!term || Array.isArray(term.genes)) return;

    const targetDiv = detailsEl.querySelector(".ora-genes-slot");
    if (!targetDiv) return;
    targetDiv.innerHTML = `<span style="opacity:0.6; font-size:0.76rem;">Loading genes...</span>`;

    try {
      const res = await window.RICE2NET_API.getTermGenes({
        source: term.source,
        termId: term.termId,
        clusterGenes: cluster.genes,
      });
      term.genes = Array.isArray(res && res.genes) ? res.genes : [];
      targetDiv.innerHTML = renderGeneLinksHtml(term.genes);
    } catch (err) {
      targetDiv.innerHTML = `<span style="color:#ff8a80; font-size:0.76rem;">Could not load overlap genes.</span>`;
    }
  };

  function renderOraModalContent() {
    const titleEl = document.getElementById("d-id");
    const contentEl = document.getElementById("detail-content");
    if (!titleEl || !contentEl) return;

    if (!CLUSTER_STATE.legend || CLUSTER_STATE.legend.length === 0) {
      titleEl.innerHTML = "Community Discovery — ORA Results";
      contentEl.innerHTML = `<div style="padding:20px; opacity:0.7;">No ORA clusters are currently displayed.</div>`;
      return;
    }

    let selected = CLUSTER_STATE.byId.get(String(activeOraClusterId));
    if (!selected) {
      selected = CLUSTER_STATE.legend[0];
      activeOraClusterId = selected.id;
    }

    const stats = CLUSTER_STATE.lastStats || {};
    const bgLine = formatBackgroundLabel(stats.background);

    titleEl.innerHTML = `
      <span data-cluster-color-id="${escapeHtml(
        selected.id
      )}" style="display:inline-block; width:18px; height:18px; border-radius:4px; background:${escapeHtml(
        selected.color
      )}; margin-right:12px; flex-shrink:0;"></span>
      <span style="font-size:1.65rem;">Community Discovery — ORA Report</span>
    `;

    const tabsHtml = CLUSTER_STATE.legend
      .map((c) => {
        const isAct = c.id === selected.id;
        return `
        <button type="button" class="ora-tab-btn ${isAct ? "active" : ""}" onclick="window.selectOraClusterTab('${escapeHtml(
          c.id
        )}')">
          <span class="ora-tab-swatch" data-cluster-color-id="${escapeHtml(
            c.id
          )}" style="background:${escapeHtml(c.color)};"></span>
          <span>${escapeHtml(c.name)}</span>
          <span style="opacity:0.65; font-size:0.78rem;">(${c.count})</span>
        </button>
      `;
      })
      .join("");

    const allTerms = selected.terms || [];
    const sourceCounts = { ALL: allTerms.length };
    allTerms.forEach((t) => {
      sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
    });
    const availableSources = ["ALL", "GO:BP", "GO:MF", "GO:CC", "MapMan", "KEGG"].filter(
      (s) => s === "ALL" || (sourceCounts[s] && sourceCounts[s] > 0)
    );
    if (!availableSources.includes(activeOraSourceFilter)) {
      activeOraSourceFilter = "ALL";
    }

    const filterChipsHtml = availableSources
      .map(
        (s) => `
      <button type="button" class="ora-filter-chip ${
        activeOraSourceFilter === s ? "active" : ""
      }" onclick="window.setOraSourceFilter('${escapeHtml(s)}')">
        ${escapeHtml(s)} (${sourceCounts[s] || 0})
      </button>
    `
      )
      .join("");

    const filteredPairs = allTerms
      .map((term, origIdx) => ({ term, origIdx }))
      .filter(({ term }) => activeOraSourceFilter === "ALL" || term.source === activeOraSourceFilter)
      .sort((a, b) => compareOraTerms(a.term, b.term));

    // Shared 0..maxFold axis across all terms in this cluster view
    let maxFold = 1;
    for (let i = 0; i < filteredPairs.length; i++) {
      const f = Number(filteredPairs[i].term.foldEnrichment) || 0;
      if (f > maxFold) maxFold = f;
    }

    // Build multi-parameter sort toolbar (Primary -> Secondary -> Tertiary)
    const buildSortControl = (levelIdx, labelText, allowNone) => {
      const crit = oraSortCriteria[levelIdx] || { key: "none", dir: "asc" };
      const optionsHtml =
        (allowNone
          ? `<option value="none" ${crit.key === "none" ? "selected" : ""}>None</option>`
          : "") +
        ORA_SORT_FIELDS.map(
          (f) =>
            `<option value="${escapeHtml(f.key)}" ${
              crit.key === f.key ? "selected" : ""
            }>${escapeHtml(f.label)}</option>`
        ).join("");
      const dirLabel = crit.dir === "desc" ? "&darr;" : "&uarr;";
      const dirTitle = crit.dir === "desc" ? "Descending (click to flip)" : "Ascending (click to flip)";
      const disabledAttr = crit.key === "none" ? "disabled" : "";

      return `
        <div class="ora-sort-level">
          <span class="ora-sort-label">${labelText}</span>
          <select class="ora-sort-select" onchange="window.setOraSortKey(${levelIdx}, this.value)">
            ${optionsHtml}
          </select>
          <button
            type="button"
            class="ora-sort-dir-btn"
            title="${dirTitle}"
            ${disabledAttr}
            onclick="window.toggleOraSortDir(${levelIdx})"
          >${dirLabel}</button>
        </div>
      `;
    };

    const sortToolbarHtml = `
      <div class="ora-sort-bar">
        ${buildSortControl(0, "Order by", false)}
        ${buildSortControl(1, "Then", true)}
        ${buildSortControl(2, "Then", true)}
        <button type="button" class="ora-sort-reset-btn" title="Reset to default order (Adj. p ↑, Fold ↓, Overlap ↓)" onclick="window.resetOraSort()">Reset</button>
      </div>
    `;

    const headerSortBadge = (fieldKey) => {
      const idx = oraSortCriteria.findIndex((c) => c && c.key === fieldKey);
      if (idx === -1) return "";
      const arrow = oraSortCriteria[idx].dir === "desc" ? "↓" : "↑";
      const rank = oraSortCriteria.filter((c) => c && c.key !== "none").length > 1 ? `${idx + 1}` : "";
      return `<span class="ora-th-sort-badge">${rank}${arrow}</span>`;
    };

    const rowsHtml = filteredPairs
      .map(({ term: t, origIdx }) => {
        const foldVal = Number(t.foldEnrichment) || 0;
        const ratio = maxFold > 0 ? Math.max(0, Math.min(1, foldVal / maxFold)) : 0;
        const barWidthPct = (ratio * 100).toFixed(2);
        const barColor = foldRatioToColor(ratio);

        const hasPreloadedGenes = Array.isArray(t.genes);
        const genesContent = hasPreloadedGenes ? renderGeneLinksHtml(t.genes) : "";
        const onToggleAttr = hasPreloadedGenes
          ? ""
          : `ontoggle="window.loadTermOverlapGenes('${escapeHtml(selected.id)}', ${origIdx}, this)"`;

        return `
          <tr>
            <td><span class="ora-source-badge">${escapeHtml(t.source)}</span></td>
            <td>${getTermLinkHtml(t)}</td>
            <td>
              <div>${escapeHtml(t.name)}</div>
              <details style="margin:4px 0 0 0; padding:0; border:none;" ${onToggleAttr}>
                <summary style="font-size:0.75rem; color:#888; margin:0; font-weight:normal;">Genes (${t.overlap})</summary>
                <div class="ora-genes-slot" style="margin-top:4px; line-height:1.5; word-break:break-all;">${genesContent}</div>
              </details>
            </td>
            <td style="white-space:nowrap; font-family:monospace;">${t.overlap} / ${t.termSize} <span style="opacity:0.6; font-size:0.76rem;">(n=${t.querySize}, N=${t.backgroundSize})</span></td>
            <td style="white-space:nowrap; font-family:monospace;">${formatPValue(t.pValue)}</td>
            <td style="white-space:nowrap; font-family:monospace; font-weight:bold;">${formatPValue(t.pAdj)}</td>
            <td class="ora-fold-cell">
              <div class="ora-fold-wrap" title="Fold: ${foldVal.toFixed(2)}× (scale: 0 to ${maxFold.toFixed(1)}×)">
                <div class="ora-fold-track">
                  <div class="ora-fold-bar" style="width:${barWidthPct}%; background:${barColor};"></div>
                </div>
                <span class="ora-fold-val">${foldVal.toFixed(2)}&times;</span>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    const emptyNotice =
      filteredPairs.length === 0
        ? `<tr><td colspan="7" style="text-align:center; padding:18px; opacity:0.65;">No significant ORA terms at the current adjusted p-value threshold.</td></tr>`
        : "";

    const mtSummary =
      stats.markovTime !== undefined && stats.markovTime !== null
        ? `<strong>Markov Time:</strong> ${escapeHtml(stats.markovTime)} &middot; `
        : "";

    contentEl.innerHTML = `
      <div style="font-size:0.84rem; opacity:0.8; margin-bottom:12px;">
        ${mtSummary}<strong>Threshold:</strong> FDR &le; ${escapeHtml(
      stats.pvalThreshold ?? 0.05
    )}${bgLine ? ` &middot; <strong>Background:</strong> ${escapeHtml(bgLine)}` : ""}
      </div>

      <div class="ora-cluster-tabs">${tabsHtml}</div>

      <div class="ora-cluster-toolbar">
        <input
          type="color"
          class="cluster-color-input"
          data-cluster-color-id="${escapeHtml(selected.id)}"
          style="width:28px; height:28px;"
          value="${escapeHtml(selected.color)}"
          title="Change Cluster Color"
          oninput="window.setClusterColor('${escapeHtml(selected.id)}', this.value, false)"
          onchange="window.setClusterColor('${escapeHtml(selected.id)}', this.value, true)"
        />
        <input
          type="text"
          class="ora-name-input"
          value="${escapeHtml(selected.name)}"
          title="Rename Cluster"
          onchange="window.renameCluster('${escapeHtml(selected.id)}', this.value)"
          onkeydown="if(event.key==='Enter'){this.blur();}"
        />
        <span style="font-size:0.84rem; opacity:0.8; white-space:nowrap;">${selected.count} genes &middot; ${allTerms.length} ORA term${allTerms.length === 1 ? "" : "s"}</span>
        <button type="button" class="ora-small-btn" onclick="window.exportClusterGenesTSV('${escapeHtml(
          selected.id
        )}')">Export Genes (.tsv)</button>
        <button type="button" class="ora-small-btn" onclick="window.exportClusterOraTSV('${escapeHtml(
          selected.id
        )}')">Export Cluster ORA (.tsv)</button>
        <button type="button" class="ora-small-btn" onclick="window.exportClusterOraTSV()">Export All ORA (.tsv)</button>
        <button type="button" class="ora-small-btn ora-danger" onclick="window.deleteCluster('${escapeHtml(
          selected.id
        )}')">Delete Cluster</button>
      </div>

      <div class="ora-source-filters">${filterChipsHtml}</div>
      ${sortToolbarHtml}

      <div style="overflow-x:auto;">
        <table class="ora-table">
          <thead>
            <tr>
              <th class="ora-th-sortable" title="Click to order by Source (Shift+click for secondary)" onclick="window.clickOraHeaderSort('source', event)">Source${headerSortBadge("source")}</th>
              <th class="ora-th-sortable" title="Click to order by Term ID (Shift+click for secondary)" onclick="window.clickOraHeaderSort('termId', event)">Term ID${headerSortBadge("termId")}</th>
              <th class="ora-th-sortable" title="Click to order by Description (Shift+click for secondary)" onclick="window.clickOraHeaderSort('name', event)">Description${headerSortBadge("name")}</th>
              <th class="ora-th-sortable" title="Click to order by Overlap k (Shift+click for secondary)" onclick="window.clickOraHeaderSort('overlap', event)">Overlap (k/M)${headerSortBadge("overlap")}</th>
              <th class="ora-th-sortable" title="Click to order by p-value (Shift+click for secondary)" onclick="window.clickOraHeaderSort('pValue', event)">p-value${headerSortBadge("pValue")}</th>
              <th class="ora-th-sortable" title="Click to order by Adj. p (Shift+click for secondary)" onclick="window.clickOraHeaderSort('pAdj', event)">Adj. p (FDR)${headerSortBadge("pAdj")}</th>
              <th class="ora-fold-header ora-th-sortable" title="Click to order by Fold (Shift+click for secondary)" onclick="window.clickOraHeaderSort('foldEnrichment', event)">
                <div>Fold${headerSortBadge("foldEnrichment")}</div>
                <div class="ora-fold-axis-labels"><span>0</span><span>${maxFold.toFixed(1)}&times;</span></div>
              </th>
            </tr>
          </thead>
          <tbody>${rowsHtml}${emptyNotice}</tbody>
        </table>
      </div>
    `;
  }

  window.selectOraClusterTab = function (clusterId) {
    activeOraClusterId = String(clusterId);
    renderOraModalContent();
  };

  window.setOraSourceFilter = function (src) {
    activeOraSourceFilter = String(src || "ALL");
    renderOraModalContent();
  };

  window.setOraSortKey = function (levelIdx, fieldKey) {
    const idx = Number(levelIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 2) return;
    const key = String(fieldKey || "none");
    oraSortCriteria[idx] = {
      key,
      dir: key === "none" ? "asc" : getSortFieldDefaultDir(key),
    };
    renderOraModalContent();
  };

  window.toggleOraSortDir = function (levelIdx) {
    const idx = Number(levelIdx);
    if (!oraSortCriteria[idx] || oraSortCriteria[idx].key === "none") return;
    oraSortCriteria[idx].dir = oraSortCriteria[idx].dir === "asc" ? "desc" : "asc";
    renderOraModalContent();
  };

  window.resetOraSort = function () {
    oraSortCriteria = [
      { key: "pAdj", dir: "asc" },
      { key: "foldEnrichment", dir: "desc" },
      { key: "overlap", dir: "desc" },
    ];
    renderOraModalContent();
  };

  window.clickOraHeaderSort = function (fieldKey, evt) {
    const key = String(fieldKey || "");
    if (!key) return;
    const isShift = Boolean(evt && evt.shiftKey);

    if (isShift) {
      // Shift+click updates secondary sort criterion
      if (oraSortCriteria[1] && oraSortCriteria[1].key === key) {
        oraSortCriteria[1].dir = oraSortCriteria[1].dir === "asc" ? "desc" : "asc";
      } else {
        oraSortCriteria[1] = { key, dir: getSortFieldDefaultDir(key) };
      }
    } else {
      // Normal click toggles direction if already primary, otherwise promotes to primary
      if (oraSortCriteria[0] && oraSortCriteria[0].key === key) {
        oraSortCriteria[0].dir = oraSortCriteria[0].dir === "asc" ? "desc" : "asc";
      } else {
        const rest = oraSortCriteria.filter((c) => c && c.key !== key);
        oraSortCriteria = [
          { key, dir: getSortFieldDefaultDir(key) },
          rest[0] || { key: "none", dir: "asc" },
          rest[1] || { key: "none", dir: "asc" },
        ];
      }
    }
    renderOraModalContent();
  };

  window.inspectGeneFromOra = function (geneId) {
    isOraModalOpen = false;
    if (typeof window.selectNode === "function") {
      window.selectNode(geneId);
    }
  };

  window.openClusterOraModal = function (clusterId = null) {
    if (!CLUSTER_STATE.legend || CLUSTER_STATE.legend.length === 0) return;
    if (clusterId && CLUSTER_STATE.byId.has(String(clusterId))) {
      activeOraClusterId = String(clusterId);
    } else if (!activeOraClusterId || !CLUSTER_STATE.byId.has(String(activeOraClusterId))) {
      activeOraClusterId = CLUSTER_STATE.legend[0].id;
    }

    isOraModalOpen = true;
    const box = document.getElementById("detail-box");
    const overlay = document.getElementById("detail-overlay");
    if (box) box.style.display = "flex";
    if (overlay) overlay.style.display = "block";
    const tooltip = document.getElementById("tooltip");
    if (tooltip) tooltip.style.display = "none";

    renderOraModalContent();
  };

  // =========================================================================
  // PROMOTER-BINDING MOTIFS CONTROLLER (Analyze -> Promoter-Binding Motifs)
  // =========================================================================

  function updateMotifSummary(html, variant = "normal", showClear = true) {
    const panel = document.getElementById("pbm-results-panel");
    const summaryEl = document.getElementById("pbm-status-summary");
    if (!panel || !summaryEl) return;

    summaryEl.classList.remove("cd-status-empty", "cd-status-error");
    if (!html) {
      panel.style.display = "none";
      return;
    }

    panel.style.display = "block";
    if (variant === "empty") summaryEl.classList.add("cd-status-empty");
    if (variant === "error") summaryEl.classList.add("cd-status-error");
    summaryEl.innerHTML = html;

    const clearBtn = panel.querySelector(".btn-clear");
    if (clearBtn) clearBtn.style.display = showClear ? "block" : "none";
  }

  /**
   * Executes Promoter-Binding Motif regulation discovery on the currently displayed graph,
   * replacing any previous regulation results and displaying Regulation in the Edge Legend.
   */
  window.runPromoterMotifAnalysisUI = async function () {
    const checks = Array.from(document.querySelectorAll(".pbm-source-check"));
    const selectedSources = checks.filter((c) => c.checked).map((c) => c.value);

    if (selectedSources.length === 0) {
      updateMotifSummary(
        "Please select at least one motif source before running the search.",
        "error",
        Boolean(window.REGULATION_STATE && window.REGULATION_STATE.isAvailable)
      );
      return;
    }

    const runBtn = document.getElementById("pbm-run-btn");
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = "RUNNING...";
    }
    if (document.body && document.body.classList) {
      document.body.classList.add("is-loading");
    }

    try {
      // Immediately clear all previous regulation edges, legend item, and canvas arrows BEFORE running analysis
      window.clearPromoterMotifAnalysis(false);
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => setTimeout(resolve, 20));
        } else {
          setTimeout(resolve, 20);
        }
      });

      // Query strictly the visible graph with only the newly selected motif sources
      const { matchedEdgesCount, scannedEdgesCount } = await window.fetchRegulationEdges(
        selectedSources,
        true
      );

      window.REGULATION_STATE.sources = selectedSources;
      window.REGULATION_STATE.edgeCount = matchedEdgesCount;

      if (matchedEdgesCount > 0) {
        window.REGULATION_STATE.isAvailable = true;
        VISIBILITY_STATE.EdgeBoth = 2; // Appear immediately in show state
        updateMotifSummary(
          `<div><strong>${matchedEdgesCount.toLocaleString()}</strong> regulatory edge${
            matchedEdgesCount === 1 ? "" : "s"
          } found <span style="opacity:0.75;">(out of ${scannedEdgesCount.toLocaleString()} edges)</span></div>
          <div style="font-size:0.74rem; opacity:0.8; margin-top:4px;">Sources: ${escapeHtml(
            selectedSources.join(", ")
          )}</div>`,
          "normal",
          true
        );
      } else {
        window.REGULATION_STATE.isAvailable = false;
        VISIBILITY_STATE.EdgeBoth = 0;
        updateMotifSummary(
          `No promoter-binding motif occurrences found across ${scannedEdgesCount.toLocaleString()} visible edge${
            scannedEdgesCount === 1 ? "" : "s"
          } for the selected source${selectedSources.length === 1 ? "" : "s"}.`,
          "empty",
          false
        );
      }

      if (typeof window.reapplyColors === "function") {
        window.reapplyColors();
      }
    } catch (err) {
      console.error("Promoter-Binding Motifs analysis failed:", err);
      window.REGULATION_STATE.isAvailable = false;
      VISIBILITY_STATE.EdgeBoth = 0;
      if (typeof window.reapplyColors === "function") window.reapplyColors();
      updateMotifSummary(
        escapeHtml(err.message || "Promoter-binding motif search failed."),
        "error",
        false
      );
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = "GO";
      }
      if (document.body && document.body.classList) {
        document.body.classList.remove("is-loading");
      }
    }
  };

  /**
   * Clears all regulation edges from memory and removes Regulation from the edge legend.
   */
  window.clearPromoterMotifAnalysis = function (silent = false) {
    if (typeof window.resetAllRegulationEdges === "function") {
      window.resetAllRegulationEdges();
    }
    if (typeof window.REGULATION_STATE !== "undefined") {
      window.REGULATION_STATE.isAvailable = false;
      window.REGULATION_STATE.sources = [];
      window.REGULATION_STATE.edgeCount = 0;
    }
    if (typeof VISIBILITY_STATE !== "undefined") {
      VISIBILITY_STATE.EdgeBoth = 0;
    }
    updateMotifSummary(null);
    if (!silent && typeof window.reapplyColors === "function") {
      window.reapplyColors();
    }
  };

  // Track modal open state cleanly when closeDetails is invoked
  window.addEventListener("DOMContentLoaded", () => {
    const origClose = window.closeDetails;
    if (typeof origClose === "function") {
      window.closeDetails = function () {
        isOraModalOpen = false;
        return origClose.apply(this, arguments);
      };
    }
  });
})();
