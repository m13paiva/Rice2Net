// kegg.js
// KEGG-specific rendering + preview UI.

window.KEGG = window.KEGG || {};

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escJsSingleQuoted(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, " ");
}

window.KEGG.makeLinkUrl = function (code, geneId) {
  // Strip "path:" prefix because encodeURIComponent will break the colon
  const cleanCode = String(code ?? "").replace(/^path:/i, "");
  const c = encodeURIComponent(cleanCode);

  // Strip "dosa:" prefix if your messy database already includes it to prevent dosa:dosa:
  const cleanGene = String(geneId ?? "").replace(/^dosa:/i, "");
  const r = encodeURIComponent(cleanGene);

  if (cleanGene)
    return `https://www.kegg.jp/kegg-bin/show_pathway?${c}+dosa:${r}%09red#`;
  return `https://www.kegg.jp/entry/${c}`;
};

window.KEGG.renderSection = function (node) {
  const kegg = Array.isArray(node?.keggDetail) ? node.keggDetail : [];
  if (!kegg.length) return "";

  // Use the exact kegg_gene property you hid from me, fallback to id, fallback to legacy RAP_ID
  let targetId = "";
  if (node?.kegg_gene && String(node.kegg_gene).trim() !== "") {
    targetId = String(node.kegg_gene).trim();
  } else if (node?.id) {
    targetId = String(node.id).trim();
  } else if (node?.metadata?.RAP_ID) {
    targetId = String(node.metadata.RAP_ID).split(",")[0].trim();
  }

  const geneIdJs = escJsSingleQuoted(targetId);

  const rows = kegg
    .map((k) => {
      const code = String(k.code ?? "");
      const name = String(k.name ?? "");
      const linkUrl = window.KEGG.makeLinkUrl(code, targetId);

      const codeJs = escJsSingleQuoted(code);

      return `
        <tr style="border-bottom:1px solid #333;">
          <td style="padding:6px 4px; font-family:monospace; color:#4db8ff;">${escHtml(code)}</td>
          <td style="padding:6px 4px;">${escHtml(name)}</td>
          <td style="padding:6px 4px; text-align:center; display:flex; justify-content:center; gap:8px;">
            <a href="${linkUrl}" target="_blank" title="Open in New Tab" style="color:#eee; text-decoration:none;">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>

            <div style="cursor:pointer; color:#aaa;" title="Preview Here"
                 onclick="window.toggleKeggPreview('${codeJs}', '${geneIdJs}')">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <details open style="margin-top:15px; border-top:1px solid #444; padding-top:10px;">
      <summary style="font-size:0.9rem; margin-bottom:10px; color:#bbb; cursor:pointer;">
        KEGG PATHWAYS
      </summary>
      <table style="width:100%; border-collapse:collapse; font-size:0.9rem; color:#eee;">
        <thead>
          <tr style="border-bottom:1px solid #555;">
            <th style="text-align:left; padding:4px; color:#bbb;">Code</th>
            <th style="text-align:left; padding:4px; color:#bbb;">Name</th>
            <th style="text-align:center; padding:4px; color:#bbb;">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </details>
  `;
};

window.toggleKeggPreview = function (code, geneId) {
  const detailContent = document.getElementById("detail-content");
  const url = window.KEGG.makeLinkUrl(code, geneId);

  detailContent.innerHTML = `
    <div class="preview-wrapper">
      <div class="preview-controls">
        <button class="btn-back" onclick="window.restoreDetails()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
          Back to Details
        </button>
      </div>
      <div class="preview-frame-container">
        <div class="full-preview-loader">
          <div class="dark-spinner"></div>
          <span>Loading KEGG Map...</span>
        </div>
        <iframe class="full-preview-iframe" src="${url}"
          onload="this.classList.add('loaded'); this.parentElement.querySelector('.full-preview-loader').style.display='none';">
        </iframe>
      </div>
    </div>
  `;
};

window.restoreDetails = function () {
  if (SELECTED_NODE && typeof window.showNodeDetails === "function") {
    window.showNodeDetails(SELECTED_NODE);
  }
};
