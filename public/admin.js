const socket = io();

const requestUrlBadge = document.getElementById('requestUrlBadge');
const qrCodeBox = document.getElementById('qrCodeBox');
const liveSongCard = document.getElementById('liveSongCard');
const statQueueCount = document.getElementById('statQueueCount');
const statWaitTime = document.getElementById('statWaitTime');
const runtimeTile = document.getElementById('runtimeTile');
const playlistTile = document.getElementById('playlistTile');
const playwrightForm = document.getElementById('playwrightForm');
const playwrightEnabledInput = document.getElementById('playwrightEnabledInput');
const playwrightHeadlessInput = document.getElementById('playwrightHeadlessInput');
const playwrightAutoMinimizeInput = document.getElementById('playwrightAutoMinimizeInput');
const playwrightAutoPlayInput = document.getElementById('playwrightAutoPlayInput');
const playwrightBrowserChannelInput = document.getElementById('playwrightBrowserChannelInput');
const playwrightUserDataDirInput = document.getElementById('playwrightUserDataDirInput');
const playwrightPlaylistNameInput = document.getElementById('playwrightPlaylistNameInput');
const endSessionButton = document.getElementById('endSessionButton');
const launchPlaywrightButton = document.getElementById('launchPlaywrightButton');
const openPlaylistButton = document.getElementById('openPlaylistButton');
const playPlaylistButton = document.getElementById('playPlaylistButton');
const closePlaywrightButton = document.getElementById('closePlaywrightButton');
const playwrightSummary = document.getElementById('playwrightSummary');

let latestState = null;
let playwrightInfo = null;
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (latestState) renderAll(latestState);
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAll(state) {
  const config = state.netease?.playwright || {};
  const status = playwrightInfo?.status || {};
  const queueTiming = state.queueTiming || {};
  const currentSong = queueTiming.currentSong || state.nowPlaying || null;
  const nextRequest = queueTiming.nextRequest || null;
  const queueLength = typeof queueTiming.queueLength === 'number' ? queueTiming.queueLength : 0;

  // — 当前播放卡 —
  if (currentSong) {
    const remainingHtml = currentSong.remainingText
      ? `<div class="adm-song-remaining">还剩 ${escapeHtml(currentSong.remainingText)}</div>`
      : currentSong.durationText
        ? `<div class="adm-song-remaining">时长 ${escapeHtml(currentSong.durationText)}</div>`
        : '';
    liveSongCard.innerHTML = `
      <div class="adm-card-eyebrow">CURRENT SONG</div>
      <div class="adm-song-title">${escapeHtml(currentSong.title || '当前播放')}</div>
      <div class="adm-song-artist">${escapeHtml(currentSong.artist || '未知歌手')}</div>
      ${remainingHtml}
    `;
    liveSongCard.className = 'adm-card adm-song-card adm-song-playing';
  } else {
    liveSongCard.innerHTML = `
      <div class="adm-card-eyebrow">CURRENT SONG</div>
      <div class="adm-song-empty">暂无播放中的歌曲</div>
    `;
    liveSongCard.className = 'adm-card adm-song-card';
  }

  // — 队列统计 —
  statQueueCount.textContent = queueLength;
  if (nextRequest?.estimatedWaitText && nextRequest.estimatedWaitText !== '00:00') {
    statWaitTime.textContent = nextRequest.estimatedWaitText;
  } else {
    statWaitTime.textContent = '00:00';
  }

  // — 浏览器状态 —
  const runningLabel = status.running ? '浏览器已接管' : '浏览器未启动';
  const runningClass = status.running ? 'adm-status-on' : 'adm-status-off';
  runtimeTile.innerHTML = `
    <div class="adm-runtime-row">
      <span class="${runningClass} adm-status-dot"></span>
      <strong>${runningLabel}</strong>
    </div>
    <div class="adm-runtime-meta">网易云：${status.loggedIn ? '已登录' : '未登录'}</div>
    <div class="adm-runtime-meta">自动写歌单：${config.enabled ? '开启' : '关闭'}</div>
    <div class="adm-runtime-meta">自动点播放：${config.autoPlayAfterSync === false ? '关闭' : '开启'}</div>
  `;

  // — 歌单链接 —
  const playlistName = status.targetPlaylistName || config.targetPlaylistName || '共享歌单';
  const playlistUrl = state.netease?.targetPlaylistCanonicalUrl || '#';
  playlistTile.innerHTML = `
    <div class="adm-playlist-name">${escapeHtml(playlistName)}</div>
    <a class="adm-playlist-link" href="${escapeHtml(playlistUrl)}" target="_blank" rel="noreferrer">打开网易云歌单 →</a>
    <div class="adm-runtime-meta">当前页面：${escapeHtml(status.currentUrl || '无')}</div>
  `;

  // — 表单字段（仅在未聚焦时更新） —
  playwrightEnabledInput.checked = Boolean(config.enabled);
  playwrightHeadlessInput.checked = Boolean(config.headless);
  playwrightAutoMinimizeInput.checked = config.autoMinimize !== false;
  playwrightAutoPlayInput.checked = config.autoPlayAfterSync !== false;
  if (document.activeElement !== playwrightBrowserChannelInput) {
    playwrightBrowserChannelInput.value = config.browserChannel || '';
  }
  if (document.activeElement !== playwrightUserDataDirInput) {
    playwrightUserDataDirInput.value = config.userDataDir || 'data/playwright-profile';
  }
  if (document.activeElement !== playwrightPlaylistNameInput) {
    playwrightPlaylistNameInput.value = config.targetPlaylistName || '';
  }

  // — Automation Summary —
  playwrightSummary.className = 'adm-summary-content';
  playwrightSummary.innerHTML = `
    <div class="adm-summary-row"><span>浏览器通道</span><strong>${escapeHtml(status.browserChannel || config.browserChannel || '(bundled chromium)')}</strong></div>
    <div class="adm-summary-row"><span>用户目录</span><strong>${escapeHtml(status.resolvedUserDataDir || config.userDataDir || '—')}</strong></div>
    <div class="adm-summary-row"><span>点歌地址</span><strong>${escapeHtml(requestUrlBadge.textContent || '—')}</strong></div>
    <div class="adm-summary-row"><span>最近动作</span><strong>${escapeHtml(config.lastAction || '无')}</strong></div>
    <div class="adm-summary-row adm-summary-row-error"><span>最近错误</span><strong>${escapeHtml(config.lastError || '无')}</strong></div>
  `;
}

function renderState(state) {
  latestState = state;
  scheduleRender();
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}

playwrightForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await post('/api/config/netease-playwright', {
    enabled: playwrightEnabledInput.checked,
    headless: playwrightHeadlessInput.checked,
    autoMinimize: playwrightAutoMinimizeInput.checked,
    autoPlayAfterSync: playwrightAutoPlayInput.checked,
    browserChannel: playwrightBrowserChannelInput.value,
    userDataDir: playwrightUserDataDirInput.value,
    targetPlaylistName: playwrightPlaylistNameInput.value
  });
  await loadPlaywrightStatus();
});

launchPlaywrightButton.addEventListener('click', async () => {
  await post('/api/netease/playwright/launch');
  await loadPlaywrightStatus();
});

openPlaylistButton.addEventListener('click', async () => {
  await post('/api/netease/playwright/open-playlist');
  await loadPlaywrightStatus();
});

playPlaylistButton.addEventListener('click', async () => {
  await post('/api/netease/playwright/play-playlist');
  await loadPlaywrightStatus();
});

closePlaywrightButton.addEventListener('click', async () => {
  await post('/api/netease/playwright/close');
  await loadPlaywrightStatus();
});

endSessionButton.addEventListener('click', async () => {
  const confirmed = window.confirm('确认结束本次歌单？当前播放、队列和历史记录将全部清空。');
  if (!confirmed) return;
  endSessionButton.disabled = true;
  endSessionButton.textContent = '清理中...';
  try {
    await post('/api/player/clear');
  } catch (err) {
    alert(`清理失败：${err.message}`);
  } finally {
    endSessionButton.disabled = false;
    endSessionButton.innerHTML = '<span class="adm-btn-icon">■</span> 结束本次歌单';
  }
});

async function loadMeta() {
  const response = await fetch('/api/meta');
  const data = await response.json();

  requestUrlBadge.textContent = data.requestUrl;
  requestUrlBadge.href = data.requestUrl;

  if (data.qrSvg && qrCodeBox) {
    qrCodeBox.innerHTML = data.qrSvg;
    const svgEl = qrCodeBox.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.style.cssText = 'width:100%;height:auto;display:block;';
    }
  }
}

async function loadState() {
  const response = await fetch('/api/state');
  const data = await response.json();
  renderState(data);
}

let playwrightStatusPending = false;

async function loadPlaywrightStatus() {
  if (playwrightStatusPending) return playwrightInfo;
  playwrightStatusPending = true;
  try {
    const response = await fetch('/api/netease/playwright-status');
    playwrightInfo = await response.json();
    if (latestState) scheduleRender();
    return playwrightInfo;
  } finally {
    playwrightStatusPending = false;
  }
}

socket.on('state:update', renderState);

Promise.all([loadMeta(), loadPlaywrightStatus(), loadState()]).catch(() => {
  if (playwrightSummary) {
    playwrightSummary.textContent = '状态加载失败，请刷新页面';
  }
});

setInterval(() => {
  loadPlaywrightStatus().catch(() => {});
}, 10000);
