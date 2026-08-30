// PrivAgent background service worker.
// Brokers messages between the side panel and the active tab. It holds no page content:
// SCAN_PAGE / SCROLL_VIEWPORT are relayed to the content script, which returns only
// structured inputs (SCAN_PAGE) or a scroll offset (SCROLL_VIEWPORT).
//
// ROBUST DELIVERY: declared content scripts only auto-inject into pages loaded AFTER the
// extension, so a tab opened earlier (or one whose async content-script loader has not yet
// registered its listener) has no receiver and `sendMessage` fails with `lastError`. Rather
// than surface PAGE_UNREACHABLE immediately, we inject the content script on demand with
// `chrome.scripting.executeScript` (using our `scripting` + http/https `host_permissions`,
// no extra grant needed) and retry. PAGE_UNREACHABLE is reported ONLY when injection itself
// is refused — i.e. the browser genuinely forbids access (fail closed, CLAUDE.md §5 Rule 7).

import { isRestrictedUrl } from '../perception/visual/restricted';
import {
  CAPTURE_VIEWPORT,
  SCAN_PAGE,
  SCROLL_VIEWPORT,
  type CaptureViewportResponse,
  type ScanPageResponse,
  type ScrollViewportResponse,
} from '../types/messages';
import { registerVisualPerceptionMessages } from './visual-messages';

chrome.runtime.onInstalled.addListener(() => {
  // Open the side panel when the toolbar action is clicked.
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});

/** Send a message to a tab, resolving the response (or `undefined` on `lastError`). */
function sendToTab<T>(tabId: number, message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response?: T) => {
      // Reading lastError marks it handled; we never forward its text (may echo the URL).
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

/**
 * Ensure the content script is present in `tabId` by injecting the built content-script
 * file(s) listed in the manifest. Returns true on success. Uses `scripting` +
 * `host_permissions`; the browser refuses on pages it protects (→ false → fail closed).
 */
async function injectContentScript(tabId: number): Promise<boolean> {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (files.length === 0) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch {
    return false;
  }
}

/**
 * Relay `message` to the active tab, injecting the content script on demand if the first
 * attempt finds no receiver. `onMissing` builds the fail-closed response used when the tab
 * is absent, restricted, or genuinely unreachable.
 */
async function relayToActiveTab<T>(
  message: unknown,
  isMissing: (response: T | undefined) => boolean,
  fail: (code: string) => T,
): Promise<T> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (activeTab?.id === undefined) return fail('NO_ACTIVE_TAB');
  if (isRestrictedUrl(activeTab.url ?? '')) return fail('RESTRICTED');
  const tabId = activeTab.id;

  let response = await sendToTab<T>(tabId, message);
  if (isMissing(response)) {
    // No receiver yet — inject the content script and retry once it has settled.
    const injected = await injectContentScript(tabId);
    if (!injected) return fail('PAGE_UNREACHABLE');
    // The built content script registers its listener from an async dynamic import; give
    // it a couple of short attempts to settle before giving up.
    for (let attempt = 0; attempt < 3 && isMissing(response); attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      response = await sendToTab<T>(tabId, message);
    }
    if (isMissing(response)) return fail('PAGE_UNREACHABLE');
  }
  return response as T;
}

/**
 * Capture the active tab's visible viewport as a PNG data URL, resolving the tab's OWN
 * `windowId` first. This is the reason capture is brokered here rather than run in the
 * side panel: from a panel document `WINDOW_ID_CURRENT` (-2) does not reliably resolve to
 * the window that holds the web page, so `captureVisibleTab` there fails on ordinary pages.
 * The background worker already resolves the active tab reliably (same path as SCAN_PAGE).
 * The returned data URL is local only — it is handed straight back to the panel for local
 * rasterization and never leaves the device.
 */
function captureActiveViewport(): Promise<CaptureViewportResponse> {
  return new Promise((resolve) => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id === undefined || activeTab.windowId === undefined) {
        resolve({ error: 'NO_ACTIVE_TAB' });
        return;
      }
      if (isRestrictedUrl(activeTab.url ?? '')) {
        resolve({ restricted: true });
        return;
      }
      chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' }, (dataUrl) => {
        // The Chrome error string is an API diagnostic (never pixels/page text); forward it
        // so a VISUAL_CAPTURE_UNAVAILABLE has a visible cause. `dataUrl` is local only.
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ error: lastError.message ?? 'CAPTURE_FAILED' });
          return;
        }
        if (!dataUrl) {
          resolve({ error: 'EMPTY_CAPTURE' });
          return;
        }
        resolve({ dataUrl });
      });
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === SCAN_PAGE) {
    void relayToActiveTab<ScanPageResponse>(
      { type: SCAN_PAGE },
      // A missing receiver yields `undefined`; a real scan always has pageText or an error.
      (response) => response === undefined,
      (code) => (code === 'RESTRICTED' ? { restricted: true } : { error: code }),
    ).then(sendResponse);
    return true; // async sendResponse
  }

  if (message?.type === SCROLL_VIEWPORT) {
    void relayToActiveTab<ScrollViewportResponse>(
      { type: SCROLL_VIEWPORT, top: message.top },
      (response) => response === undefined,
      (code) => ({ error: code }),
    ).then(sendResponse);
    return true; // async sendResponse
  }

  if (message?.type === CAPTURE_VIEWPORT) {
    void captureActiveViewport().then(sendResponse);
    return true; // async sendResponse
  }

  return undefined;
});

// M3: additional message type on the same runtime channel (see visual-messages.ts).
registerVisualPerceptionMessages();

export {};
