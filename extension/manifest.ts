import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'PrivAgent',
  version: '0.1.0',
  description: 'Privacy-preserving AI browser agent for the SIH project.',
  // `sidePanel` is REQUIRED for `chrome.sidePanel.*` to exist in the worker. Without it
  // `chrome.sidePanel` is undefined, so `setPanelBehavior({ openPanelOnActionClick })`
  // silently no-ops and — with no `default_popup` — clicking the toolbar icon does nothing.
  permissions: ['storage', 'activeTab', 'scripting', 'sidePanel'],
  // `chrome.tabs.captureVisibleTab` (M3 viewport capture) accepts ONLY the literal
  // `<all_urls>` host permission, or `activeTab` PLUS a qualifying user gesture (an
  // action/menu/command click). Broad patterns like `http://*/*` + `https://*/*` are NOT
  // accepted for it, and our capture is triggered from a side-panel button (not a gesture
  // that grants activeTab) — so `<all_urls>` is the documented minimum that lets capture
  // succeed on ordinary pages. Verified against Chrome docs; not invented (CLAUDE.md §3).
  // The captured data URL is rasterized locally and never leaves the device (§5, §9).
  host_permissions: ['<all_urls>'],
  // The local OCR engine (Tesseract.js) instantiates WebAssembly in the side-panel
  // document, which MV3 forbids under the default CSP. `'wasm-unsafe-eval'` permits
  // wasm compilation ONLY; no remote/eval script is allowed. All OCR assets
  // (worker, wasm core, language data) are packaged and loaded from the extension
  // origin ('self') — never from a network origin (CLAUDE.md §5, §9).
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  background: {
    service_worker: 'extension/src/background/index.ts',
    type: 'module',
  },
  action: {
    default_title: 'PrivAgent',
    // No `default_popup`: the toolbar action opens the SIDE PANEL (see background
    // `openPanelOnActionClick`). A `default_popup` here would take precedence and
    // suppress that behavior, so it is intentionally omitted.
    // default_icon: {
    //   '16': 'icons/icon-16.png',
    //   '48': 'icons/icon-48.png',
    //   '128': 'icons/icon-128.png',
    // },
  },
  side_panel: {
    default_path: 'extension/src/sidepanel/index.html',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['extension/src/content/index.js'],
      run_at: 'document_idle',
    },
  ],
  // icons: {
  //   '16': 'icons/icon-16.png',
  //   '48': 'icons/icon-48.png',
  //   '128': 'icons/icon-128.png',
  // },
});
