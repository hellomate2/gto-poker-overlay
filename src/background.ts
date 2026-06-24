// ============================================================
// Background Service Worker
// Handles extension lifecycle and message routing
// ============================================================

chrome.runtime.onInstalled.addListener(() => {
  console.log('[GTO Bot] Extension installed');

  // Set default settings
  chrome.storage.local.get('botSettings', (result) => {
    if (!result.botSettings) {
      chrome.storage.local.set({
        botSettings: {
          autoPlay: true,
          advisoryMode: false,
          actionDelayMin: 300,
          actionDelayMax: 1200,
          exploitWeight: 0.5,
          showHud: true,
          showEquity: true,
          confirmAllIn: false,
          cfrIterations: 10000,
          cfrTimeLimit: 1500,
        },
      });
    }
  });
});

// Message routing between popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RESET_ALL_STATS') {
    // Forward to all PokerNow tabs
    chrome.tabs.query({}, (tabs) => {
      tabs = tabs.filter(t => t.url && (t.url.includes('pokernow.club') || t.url.includes('pokernow.com')));
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'RESET_ALL_STATS' });
        }
      }
    });
    sendResponse({ ok: true });
  }

  return true; // keep channel open for async
});
