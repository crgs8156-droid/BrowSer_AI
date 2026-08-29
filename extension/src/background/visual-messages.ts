// M3 background wiring: serves visual-candidate snapshots to the side panel.
//
// This reuses the EXISTING transport (`chrome.runtime.onMessage` with a `type`
// discriminator) and the EXISTING injection pattern (`chrome.scripting.executeScript`)
// introduced in M1. No new messaging system is added; this is an additional message
// type on the same channel, kept in its own module so M1's worker stays untouched.
//
// The heavy work does NOT happen here: an MV3 service worker has no document, no
// canvas and no WebGPU, so it cannot rasterize or analyse. The worker only brokers
// cheap DOM metadata; capture and analysis run in the side panel's document context.

import { collectVisualCandidatesInPage } from '../perception/visual/collect-candidates';
import { isRestrictedUrl } from '../perception/visual/restricted';
import { COLLECT_VISUAL_CANDIDATES, type VisualCandidatesResponse } from '../types/messages';

export function registerVisualPerceptionMessages(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== COLLECT_VISUAL_CANDIDATES) return undefined;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];

      if (activeTab?.id === undefined) {
        sendResponse({ error: 'NO_ACTIVE_TAB' } satisfies VisualCandidatesResponse);
        return;
      }

      // `tab.url` is only readable where we hold host permissions, so an empty URL
      // means "cannot establish that this page is operable" → treat as restricted.
      // Fail closed (CLAUDE.md §5 Rule 7).
      if (isRestrictedUrl(activeTab.url ?? '')) {
        sendResponse({ restricted: true } satisfies VisualCandidatesResponse);
        return;
      }

      chrome.scripting.executeScript(
        { target: { tabId: activeTab.id }, func: collectVisualCandidatesInPage },
        (results) => {
          if (chrome.runtime.lastError !== undefined) {
            // Chrome refuses injection on protected surfaces. The message text can
            // echo the URL, so only a fixed code is forwarded.
            sendResponse({ restricted: true } satisfies VisualCandidatesResponse);
            return;
          }
          const snapshot = results?.[0]?.result ?? null;
          sendResponse({ snapshot } satisfies VisualCandidatesResponse);
        },
      );
    });

    return true; // async sendResponse
  });
}
