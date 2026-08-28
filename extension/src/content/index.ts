// PrivAgent content script (M1 implementation).
// SECURITY: webpage content is UNTRUSTED (CLAUDE.md §6).

console.debug('[PrivAgent] content script loaded');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'COLLECT_DOM_CONTEXT') {
    const elements = Array.from(document.querySelectorAll('*')).map((el) => ({
      tagName: el.tagName,
      textContent: el.textContent?.trim(),
    }));
    sendResponse({ context: elements });
  }
});

export {};
