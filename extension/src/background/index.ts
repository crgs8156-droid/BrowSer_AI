// PrivAgent background service worker (M1 implementation).
// Handles communication between the side panel and content script.

chrome.runtime.onInstalled.addListener(() => {
  // Open the side panel when the toolbar action is clicked.
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'COLLECT_DOM_CONTEXT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id) {
        chrome.scripting.executeScript(
          {
            target: { tabId: activeTab.id },
            func: () => {
              const elements = Array.from(document.querySelectorAll('*')).map((el) => ({
                tagName: el.tagName,
                textContent: el.textContent?.trim(),
              }));
              return elements;
            },
          },
          (results) => {
            sendResponse({ context: results?.[0]?.result || [] });
          }
        );
      } else {
        sendResponse({ error: 'No active tab found.' });
      }
    });
    return true; // Keep the message channel open for async response.
  }
});

export {};
