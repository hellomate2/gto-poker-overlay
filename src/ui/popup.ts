import { BotSettings, DEFAULT_SETTINGS } from '../types/poker';

// ============================================================
// Extension Popup Script
// Manages settings and displays session stats
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Load settings from storage
  const settings = await loadSettings();
  applySettingsToUI(settings);

  // Setup event listeners
  setupToggle('autoPlay', settings);
  setupToggle('showHud', settings);
  setupToggle('showEquity', settings);
  setupToggle('confirmAllIn', settings);

  // Sliders
  const exploitSlider = document.getElementById('exploitWeight') as HTMLInputElement;
  const cfrSlider = document.getElementById('cfrIterations') as HTMLInputElement;
  const delaySlider = document.getElementById('actionDelay') as HTMLInputElement;

  exploitSlider?.addEventListener('input', () => {
    const val = parseInt(exploitSlider.value);
    document.getElementById('exploitWeightValue')!.textContent = `${val}%`;
    settings.exploitWeight = val / 100;
    saveSettings(settings);
    sendSettingsToContentScript(settings);
  });

  cfrSlider?.addEventListener('input', () => {
    const val = parseInt(cfrSlider.value);
    document.getElementById('cfrIterValue')!.textContent = val.toString();
    settings.cfrIterations = val;
    saveSettings(settings);
    sendSettingsToContentScript(settings);
  });

  delaySlider?.addEventListener('input', () => {
    const val = parseInt(delaySlider.value);
    const min = Math.max(500, val - 2000);
    document.getElementById('delayValue')!.textContent = `${(min / 1000).toFixed(1)}-${(val / 1000).toFixed(1)}s`;
    settings.actionDelayMin = min;
    settings.actionDelayMax = val;
    saveSettings(settings);
    sendSettingsToContentScript(settings);
  });

  // Reset button
  document.getElementById('resetStats')?.addEventListener('click', async () => {
    if (confirm('Reset all tracked opponent data? This cannot be undone.')) {
      chrome.runtime.sendMessage({ type: 'RESET_ALL_STATS' });
    }
  });

  // Request current stats from content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_SESSION_STATS' }, (response) => {
        if (response) updateSessionStats(response);
      });
    }
  });

  // Check connection status
  checkConnectionStatus();
});

function setupToggle(id: string, settings: BotSettings): void {
  const toggle = document.getElementById(id) as HTMLInputElement;
  if (!toggle) return;

  toggle.addEventListener('change', () => {
    (settings as any)[id] = toggle.checked;
    saveSettings(settings);
    sendSettingsToContentScript(settings);
  });
}

function applySettingsToUI(settings: BotSettings): void {
  (document.getElementById('autoPlay') as HTMLInputElement).checked = settings.autoPlay;
  (document.getElementById('showHud') as HTMLInputElement).checked = settings.showHud;
  (document.getElementById('showEquity') as HTMLInputElement).checked = settings.showEquity;
  (document.getElementById('confirmAllIn') as HTMLInputElement).checked = settings.confirmAllIn;

  (document.getElementById('exploitWeight') as HTMLInputElement).value = String(settings.exploitWeight * 100);
  document.getElementById('exploitWeightValue')!.textContent = `${(settings.exploitWeight * 100).toFixed(0)}%`;

  (document.getElementById('cfrIterations') as HTMLInputElement).value = String(settings.cfrIterations);
  document.getElementById('cfrIterValue')!.textContent = String(settings.cfrIterations);

  (document.getElementById('actionDelay') as HTMLInputElement).value = String(settings.actionDelayMax);
  document.getElementById('delayValue')!.textContent =
    `${(settings.actionDelayMin / 1000).toFixed(1)}-${(settings.actionDelayMax / 1000).toFixed(1)}s`;
}

function updateSessionStats(stats: { hands: number; profit: number; vpip: number; avgSolveTime: number }): void {
  document.getElementById('handsPlayed')!.textContent = String(stats.hands);
  const plEl = document.getElementById('profitLoss')!;
  plEl.textContent = (stats.profit >= 0 ? '+' : '') + stats.profit.toFixed(2);
  plEl.style.color = stats.profit >= 0 ? '#2ecc71' : '#e74c3c';
  document.getElementById('heroVpip')!.textContent = `${stats.vpip.toFixed(0)}%`;
  document.getElementById('avgSolveTime')!.textContent = `${stats.avgSolveTime.toFixed(0)}ms`;
}

function checkConnectionStatus(): void {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || '';
    const isOnPokerNow = url.includes('pokernow.club') || url.includes('pokernow.com');
    const dot = document.getElementById('statusDot')!;
    const text = document.getElementById('statusText')!;

    if (isOnPokerNow) {
      dot.classList.add('active');
      text.textContent = 'Connected to PokerNow';
    } else {
      dot.classList.remove('active');
      text.textContent = 'Navigate to pokernow.club';
    }
  });
}

async function loadSettings(): Promise<BotSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get('botSettings', (result) => {
      resolve((result.botSettings as BotSettings) || { ...DEFAULT_SETTINGS });
    });
  });
}

async function saveSettings(settings: BotSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ botSettings: settings }, resolve);
  });
}

function sendSettingsToContentScript(settings: BotSettings): void {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'UPDATE_SETTINGS', settings });
    }
  });
}
