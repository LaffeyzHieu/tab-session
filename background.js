// ─── Constants ───────────────────────────────────────────
const TRACKED_DOMAINS = ['tiktok.com', 'youtube.com', 'facebook.com'];
const DEFAULT_LIMIT_MS    = 30 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

// ─── In-memory state ─────────────────────────────────────
const tabStates = {};

// ─── Helpers ─────────────────────────────────────────────
function getTrackedDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return TRACKED_DOMAINS.find(d => hostname.includes(d)) ?? null;
  } catch { return null; }
}

async function getSettings() {
  return chrome.storage.local.get({
    limitMs:    DEFAULT_LIMIT_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
  });
}

async function persistActiveMs(tabId) {
  const s = tabStates[tabId];
  if (!s) return;
  await chrome.storage.local.set({ [`activeMs_${s.domain}`]: s.activeMs });
}

async function loadActiveMs(domain) {
  const r = await chrome.storage.local.get({ [`activeMs_${domain}`]: 0 });
  return r[`activeMs_${domain}`];
}

async function incrementBlockedCount(domain) {
  const key = `blockedCount_${domain}`;
  const r = await chrome.storage.local.get({ [key]: 0 });
  await chrome.storage.local.set({ [key]: r[key] + 1 });
}

// ─── Send message to content script ──────────────────────
function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(error => {
    console.warn(`Could not send ${message.type} to tab ${tabId}:`, error);
  });
}

// ─── Re-send overlay nếu tab đang cần hiện overlay ───────
function resendOverlayIfNeeded(tabId) {
  const state = tabStates[tabId];
  if (!state) return;
  if (state.mode === 'ended') {
    sendToTab(tabId, { type: 'SHOW_OVERLAY', screen: 'ended' });
  } else if (state.mode === 'cooldown') {
    sendToTab(tabId, { type: 'SHOW_OVERLAY', screen: 'cooldown', cooldownEndsAt: state.cooldownEndsAt });
  } else if (state.mode === 'penalty') {
    sendToTab(tabId, { type: 'SHOW_OVERLAY', screen: 'penalty', cooldownEndsAt: state.cooldownEndsAt });
  }
}

// ─── Tab init ─────────────────────────────────────────────
async function initTab(tabId, url) {
  const domain = getTrackedDomain(url);
  if (!domain) return;

  const { limitMs } = await getSettings();
  const activeMs = await loadActiveMs(domain);

  const stored = await chrome.storage.local.get({
    [`cooldownEndsAt_${domain}`]: 0,
    [`penaltyEndsAt_${domain}`]:  0,
    [`sessionEnded_${domain}`]:   false,
  });

  const now            = Date.now();
  const cooldownEndsAt = stored[`cooldownEndsAt_${domain}`];
  const penaltyEndsAt  = stored[`penaltyEndsAt_${domain}`];
  const sessionEnded   = stored[`sessionEnded_${domain}`];

  if (penaltyEndsAt > now) {
    // Đang penalty
    tabStates[tabId] = {
      domain, activeMs,
      mode: 'penalty',
      cooldownEndsAt: penaltyEndsAt,
      lastTickAt: null,
    };

  } else if (cooldownEndsAt > now) {
    // Đang cooldown
    tabStates[tabId] = {
      domain, activeMs,
      mode: 'cooldown',
      cooldownEndsAt,
      lastTickAt: null,
    };

  } else if (sessionEnded) {
    // Session ended nhưng user chưa bấm gì (survive reload)
    tabStates[tabId] = {
      domain, activeMs,
      mode: 'ended',
      cooldownEndsAt: 0,
      lastTickAt: null,
    };

  } else {
    // Bình thường — reset nếu cooldown/penalty vừa hết
    const freshActiveMs = (cooldownEndsAt > 0 || penaltyEndsAt > 0) ? 0 : activeMs;
    if (freshActiveMs !== activeMs) {
      await chrome.storage.local.set({
        [`activeMs_${domain}`]:       0,
        [`cooldownEndsAt_${domain}`]: 0,
        [`penaltyEndsAt_${domain}`]:  0,
      });
    }
    tabStates[tabId] = {
      domain,
      activeMs: freshActiveMs,
      mode: 'tracking',
      cooldownEndsAt: 0,
      lastTickAt: null,
    };
  }
}

// ─── Active tab detection ─────────────────────────────────
async function getActiveTrackedTab() {
  const windows = await chrome.windows.getAll({ populate: false });
  const focusedWin = windows.find(w => w.focused && w.type === 'normal');
  if (!focusedWin) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: focusedWin.id });
  return tab ?? null;
}

// ─── Tick ─────────────────────────────────────────────────
async function runTick() {
  const { limitMs } = await getSettings();
  const now = Date.now();
  const activeTab = await getActiveTrackedTab();
  const activeTabId = activeTab?.id;
  const activeDomain = activeTab?.url ? getTrackedDomain(activeTab.url) : null;

  for (const [tabIdStr, state] of Object.entries(tabStates)) {
    const tabId = parseInt(tabIdStr);

    // ── Ended: chờ user bấm, không đếm ──
    if (state.mode === 'ended') {
      if (tabId === activeTabId) {
        sendToTab(tabId, { type: 'SHOW_OVERLAY', screen: 'ended' });
      }
      continue;
    }

    // ── Cooldown / Penalty: check hết chưa ──
    if (state.mode === 'cooldown' || state.mode === 'penalty') {
      if (now >= state.cooldownEndsAt) {
        state.mode = 'tracking';
        state.activeMs = 0;
        state.cooldownEndsAt = 0;
        state.lastTickAt = null;
        await chrome.storage.local.set({
          [`activeMs_${state.domain}`]:       0,
          [`cooldownEndsAt_${state.domain}`]: 0,
          [`penaltyEndsAt_${state.domain}`]:  0,
          [`sessionEnded_${state.domain}`]:   false,
        });
        sendToTab(tabId, { type: 'HIDE_OVERLAY' });
      }
      continue;
    }

    // Close the previous active interval before switching to the newly active tab.
    if (state.lastTickAt !== null) {
      state.activeMs += now - state.lastTickAt;
      state.lastTickAt = null;
      await persistActiveMs(tabId);
    }
  }

  if (activeTabId === undefined) {
    return;
  }
  const activeState = tabStates[activeTabId];
  if (!activeDomain || !activeState || activeState.mode !== 'tracking') {
    return;
  }

  // Multiple tabs on the same domain share one persisted usage counter.
  activeState.activeMs = await loadActiveMs(activeState.domain);
  activeState.lastTickAt = now;

  // Kiểm tra limit
  if (activeState.activeMs >= limitMs) {
    for (const [tabIdStr, state] of Object.entries(tabStates)) {
      if (state.domain === activeState.domain) {
        state.mode = 'ended';
        state.activeMs = activeState.activeMs;
        state.lastTickAt = null;
      }
    }
    sendToTab(activeTabId, { type: 'SHOW_OVERLAY', screen: 'ended' });
    await chrome.storage.local.set({
      [`sessionEnded_${activeState.domain}`]: true,
    });
    await incrementBlockedCount(activeState.domain).catch(error => {
      console.error(`Failed to increment blocked count for ${activeState.domain}:`, error);
    });
  }
}

let tickQueue = Promise.resolve();
function tick() {
  tickQueue = tickQueue
    .then(runTick)
    .catch(error => console.error('Tab Time Limiter tick failed:', error));
  return tickQueue;
}

// ─── Message handler ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'TRACKING_HEARTBEAT') {
    const tabId = sender.tab?.id;
    const url = sender.tab?.url;
    const domain = url ? getTrackedDomain(url) : null;
    if (tabId === undefined || !domain) {
      sendResponse({ ok: false });
      return false;
    }

    (async () => {
      let state = tabStates[tabId];
      if (!state || state.domain !== domain) {
        await initTab(tabId, url);
      }
      await tick();
      state = tabStates[tabId];
      if (!state) {
        sendResponse({ ok: false });
        return;
      }

      const screen = state.mode === 'ended'
        ? 'ended'
        : state.mode === 'cooldown' || state.mode === 'penalty'
          ? state.mode
          : null;
      sendResponse({
        ok: true,
        mode: state.mode,
        screen,
        cooldownEndsAt: state.cooldownEndsAt,
      });
    })().catch(error => {
      console.error('Failed to process tracking heartbeat:', error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'GET_TAB_STATE') {
    sendResponse(tabStates[message.tabId] ?? null);
    return true;
  }

  if (message.type === 'RESET_DOMAIN') {
    const { domain } = message;
    (async () => {
      await chrome.storage.local.set({
        [`activeMs_${domain}`]:       0,
        [`cooldownEndsAt_${domain}`]: 0,
        [`penaltyEndsAt_${domain}`]:  0,
        [`sessionEnded_${domain}`]:   false,
        [`blockedCount_${domain}`]:   0,
      });
      for (const [tabIdStr, state] of Object.entries(tabStates)) {
        if (state.domain === domain) {
          state.activeMs = 0;
          state.mode = 'tracking';
          state.cooldownEndsAt = 0;
          state.lastTickAt = null;
          sendToTab(parseInt(tabIdStr), { type: 'HIDE_OVERLAY' });
        }
      }
      await tick();
      sendResponse({ ok: true });
    })().catch(error => {
      console.error(`Failed to reset ${domain}:`, error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  // User bấm "Alright" → cooldown bình thường
  if (message.type === 'USER_ALRIGHT') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId === undefined) throw new Error('Missing sender tab for USER_ALRIGHT');
      const state = tabStates[tabId];
      if (!state) throw new Error(`No tracked state for tab ${tabId}`);
      const { cooldownMs } = await getSettings();
      const cooldownEndsAt = Date.now() + cooldownMs;
      await chrome.storage.local.set({
        [`activeMs_${state.domain}`]:       0,
        [`cooldownEndsAt_${state.domain}`]: cooldownEndsAt,
        [`sessionEnded_${state.domain}`]:   false,
      });
      for (const [tabIdStr, domainState] of Object.entries(tabStates)) {
        if (domainState.domain === state.domain) {
          domainState.mode = 'cooldown';
          domainState.cooldownEndsAt = cooldownEndsAt;
          domainState.activeMs = 0;
          domainState.lastTickAt = null;
          sendToTab(parseInt(tabIdStr), {
            type: 'SHOW_OVERLAY',
            screen: 'cooldown',
            cooldownEndsAt,
          });
        }
      }
      sendResponse({ ok: true });
    })().catch(error => {
      console.error('Failed to start cooldown:', error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  // User bấm "More 1 min" → penalty = limitMs × 2
  if (message.type === 'USER_MORE_1MIN') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId === undefined) throw new Error('Missing sender tab for USER_MORE_1MIN');
      const state = tabStates[tabId];
      if (!state) throw new Error(`No tracked state for tab ${tabId}`);
      const { limitMs } = await getSettings();
      const penaltyEndsAt = Date.now() + (limitMs * 2);
      await chrome.storage.local.set({
        [`activeMs_${state.domain}`]:      0,
        [`penaltyEndsAt_${state.domain}`]: penaltyEndsAt,
        [`cooldownEndsAt_${state.domain}`]:0,
        [`sessionEnded_${state.domain}`]:  false,
      });
      for (const [tabIdStr, domainState] of Object.entries(tabStates)) {
        if (domainState.domain === state.domain) {
          domainState.mode = 'penalty';
          domainState.cooldownEndsAt = penaltyEndsAt;
          domainState.activeMs = 0;
          domainState.lastTickAt = null;
          sendToTab(parseInt(tabIdStr), {
            type: 'SHOW_OVERLAY',
            screen: 'penalty',
            cooldownEndsAt: penaltyEndsAt,
          });
        }
      }
      sendResponse({ ok: true });
    })().catch(error => {
      console.error('Failed to start penalty:', error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return true;
});

// ─── Tab events ───────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Delay nhỏ để content script inject xong
    initTab(tabId, tab.url).then(() => {
      setTimeout(() => resendOverlayIfNeeded(tabId), 500);
      return tick();
    }).catch(error => {
      console.error(`Failed to initialize tab ${tabId}:`, error);
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      await initTab(tabId, tab.url);
      setTimeout(() => resendOverlayIfNeeded(tabId), 100);
    }
    await tick();
  } catch (error) {
    console.error(`Failed to handle activated tab ${tabId}:`, error);
  }
});

chrome.windows.onFocusChanged.addListener(() => {
  tick();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await tick();
  delete tabStates[tabId];
});

// ─── Init khi extension load ──────────────────────────────
const TICK_ALARM = 'tab-time-limiter-tick';
function ensureTickAlarm() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureTickAlarm);
chrome.runtime.onStartup.addListener(ensureTickAlarm);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TICK_ALARM) tick();
});
ensureTickAlarm();

chrome.tabs.query({}, (tabs) => {
  for (const tab of tabs) {
    if (tab.url) {
      initTab(tab.id, tab.url).then(() => {
        setTimeout(() => resendOverlayIfNeeded(tab.id), 500);
        tick();
      }).catch(error => {
        console.error(`Failed to initialize tab ${tab.id}:`, error);
      });
    }
  }
});