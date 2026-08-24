// PrivAgent background service worker (M0 scaffold — orchestration only, no feature logic).
// Privacy-critical logic lives in dedicated modules (see docs/architecture.md). The service
// worker must never hold or log raw protected values.

chrome.runtime.onInstalled.addListener(() => {
  // Open the side panel when the toolbar action is clicked.
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});

export {};
