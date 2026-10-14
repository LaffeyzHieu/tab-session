const DOMAINS = ['tiktok.com', 'youtube.com', 'facebook.com'];

async function render() {
  const stored = await chrome.storage.local.get({
    limitMs: 30 * 60 * 1000,
    cooldownMs: 30 * 60 * 1000,
  });
  document.getElementById('limit-input').value   = Math.round(stored.limitMs / 60000);
  document.getElementById('cooldown-input').value = Math.round(stored.cooldownMs / 60000);

  const now = Date.now();
  const list = document.getElementById('domain-list');
  list.innerHTML = '';

  for (const domain of DOMAINS) {
    const keys = {
      activeMs:       `activeMs_${domain}`,
      cooldownEndsAt: `cooldownEndsAt_${domain}`,
      penaltyEndsAt:  `penaltyEndsAt_${domain}`,
      blockedCount:   `blockedCount_${domain}`,
    };
    const data = await chrome.storage.local.get({
      [keys.activeMs]: 0,
      [keys.cooldownEndsAt]: 0,
      [keys.penaltyEndsAt]: 0,
      [keys.blockedCount]: 0,
    });

    const activeMs       = data[keys.activeMs];
    const cooldownEndsAt = data[keys.cooldownEndsAt];
    const penaltyEndsAt  = data[keys.penaltyEndsAt];
    const blockedCount   = data[keys.blockedCount];

    const inPenalty  = penaltyEndsAt > now;
    const inCooldown = !inPenalty && cooldownEndsAt > now;

    let dotClass, statusText;
    if (inPenalty) {
      const rem = Math.ceil((penaltyEndsAt - now) / 60000);
      dotClass = 'dot-red';
      statusText = `Penalty: ${rem}m left`;
    } else if (inCooldown) {
      const rem = Math.ceil((cooldownEndsAt - now) / 60000);
      dotClass = 'dot-yellow';
      statusText = `Cooldown: ${rem}m left`;
    } else {
      const m = Math.floor(activeMs / 60000);
      const s = Math.floor((activeMs % 60000) / 1000);
      dotClass = 'dot-green';
      statusText = `${m}m ${s}s used`;
    }

    const row = document.createElement('div');
    row.className = 'domain-row';
    row.innerHTML = `
      <div>
        <div class="domain-name">
          <span class="status-dot ${dotClass}"></span>${domain}
        </div>
        <div class="domain-time">${statusText}</div>
      </div>
      <div class="domain-blocked">Blocked: ${blockedCount}x</div>
      <button class="btn-reset" data-domain="${domain}">Reset</button>
    `;
    list.appendChild(row);
  }

  list.querySelectorAll('.btn-reset').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'RESET_DOMAIN', domain });
        if (!response?.ok) {
          throw new Error(response?.error ?? `Could not reset ${domain}`);
        }
        await render();
      } catch (error) {
        console.error(`Failed to reset ${domain}:`, error);
      }
    });
  });
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const limitMins    = parseInt(document.getElementById('limit-input').value)    || 30;
  const cooldownMins = parseInt(document.getElementById('cooldown-input').value) || 30;
  await chrome.storage.local.set({
    limitMs:    limitMins    * 60 * 1000,
    cooldownMs: cooldownMins * 60 * 1000,
  });
  document.getElementById('saved-msg').style.display = 'block';
  setTimeout(() => document.getElementById('saved-msg').style.display = 'none', 1500);
});

render();
// Auto-refresh mỗi 10s để cập nhật timer
setInterval(render, 10000);