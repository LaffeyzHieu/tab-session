let overlayEl = null;
let countdownInterval = null;
let currentScreen = null;

// ── Image paths (web_accessible_resources) ───────────────
const IMG = {
  stg1:    chrome.runtime.getURL('img/stg1.png'),
  stg2:    chrome.runtime.getURL('img/stg2.png'),
  penalty: chrome.runtime.getURL('img/60min.png'),
};

// ── Screens config ────────────────────────────────────────
const SCREENS = {
  ended: {
    img: IMG.stg1,
    title: 'This session has ended',
    subtitle: null,
    showCountdown: false,
    buttons: [
      { id: 'btn-alright',  label: 'Alright',    style: 'primary' },
      { id: 'btn-more1min', label: 'More 1 min', style: 'secondary' },
    ],
  },
  cooldown: {
    img: IMG.stg2,
    title: 'This session has ended',
    subtitle: 'Return after',
    showCountdown: true,
    buttons: [],
  },
  penalty: {
    img: IMG.penalty,
    title: 'omg, u got blocked',
    subtitle: 'time left:',
    showCountdown: true,
    buttons: [],
  },
};

// ── Build overlay DOM ─────────────────────────────────────
function buildOverlay() {
  const el = document.createElement('div');
  el.id = 'ttl-overlay';
  el.innerHTML = `
    <img id="ttl-img" src="" alt="" />
    <div id="ttl-card">
      <p  id="ttl-title"></p>
      <p  id="ttl-subtitle"></p>
      <p  id="ttl-countdown"></p>
      <div id="ttl-buttons"></div>
    </div>
  `;
  return el;
}

// ── Show overlay ──────────────────────────────────────────
async function showOverlay(screen, cooldownEndsAt) {
  // Exit fullscreen nếu đang fullscreen
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch (error) {
      console.error('Tab Time Limiter could not exit fullscreen:', error);
    }
  }

  const cfg = SCREENS[screen];
  if (!cfg) return;
  if (overlayEl?.isConnected && currentScreen === screen) return;
  currentScreen = screen;

  // Tạo mới nếu chưa có
  if (!overlayEl || !overlayEl.isConnected) {
    overlayEl = buildOverlay();
    (document.body ?? document.documentElement).appendChild(overlayEl);
  }

  // Update nội dung
  overlayEl.querySelector('#ttl-img').src = cfg.img;
  overlayEl.querySelector('#ttl-title').textContent = cfg.title;

  const subtitleEl = overlayEl.querySelector('#ttl-subtitle');
  subtitleEl.textContent = cfg.subtitle ?? '';
  subtitleEl.style.display = cfg.subtitle ? 'block' : 'none';

  const countdownEl = overlayEl.querySelector('#ttl-countdown');
  countdownEl.style.display = cfg.showCountdown ? 'block' : 'none';

  // Buttons
  const btnsEl = overlayEl.querySelector('#ttl-buttons');
  btnsEl.innerHTML = '';
  for (const btn of cfg.buttons) {
    const b = document.createElement('button');
    b.id = btn.id;
    b.textContent = btn.label;
    b.className = `ttl-btn ttl-btn--${btn.style}`;
    btnsEl.appendChild(b);
  }

  // Button handlers
  overlayEl.querySelector('#btn-alright')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'USER_ALRIGHT' })
      .then(response => {
        if (!response?.ok) throw new Error(response?.error ?? 'Could not start cooldown');
      })
      .catch(error => console.error('Tab Time Limiter cooldown action failed:', error));
  });
  overlayEl.querySelector('#btn-more1min')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'USER_MORE_1MIN' })
      .then(response => {
        if (!response?.ok) throw new Error(response?.error ?? 'Could not start penalty');
      })
      .catch(error => console.error('Tab Time Limiter penalty action failed:', error));
  });

  // Countdown
  if (countdownInterval) clearInterval(countdownInterval);
  if (cfg.showCountdown && cooldownEndsAt) {
    function updateCountdown() {
      const rem = Math.max(0, cooldownEndsAt - Date.now());
      const m = Math.floor(rem / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      countdownEl.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 1000);
  }
}

// ── Remove overlay ────────────────────────────────────────
function removeOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  currentScreen = null;
}

// ── Message listener ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SHOW_OVERLAY') {
    showOverlay(message.screen, message.cooldownEndsAt).catch(error => {
      console.error('Tab Time Limiter could not render the overlay:', error);
    });
  }
  if (message.type === 'HIDE_OVERLAY') {
    removeOverlay();
  }
});

let lastHeartbeatErrorAt = 0;
function sendTrackingHeartbeat() {
  if (document.visibilityState !== 'visible') return;

  chrome.runtime.sendMessage({ type: 'TRACKING_HEARTBEAT' })
    .then(response => {
      lastHeartbeatErrorAt = 0;
      if (!response?.ok) return;
      if (response.screen) {
        showOverlay(response.screen, response.cooldownEndsAt).catch(error => {
          console.error('Tab Time Limiter could not render the heartbeat overlay:', error);
        });
      } else if (response.mode === 'tracking' && currentScreen) {
        removeOverlay();
      }
    })
    .catch(error => {
      const now = Date.now();
      if (now - lastHeartbeatErrorAt >= 30000) {
        console.warn('Tab Time Limiter heartbeat failed:', error);
        lastHeartbeatErrorAt = now;
      }
    });
}

sendTrackingHeartbeat();
setInterval(sendTrackingHeartbeat, 1000);
document.addEventListener('visibilitychange', sendTrackingHeartbeat);