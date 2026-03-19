const socket = io();

const form = document.getElementById('requestForm');
const messageBox = document.getElementById('formMessage');
const nowPlayingBox = document.getElementById('nowPlayingBox');
const neteaseHint = document.getElementById('neteaseHint');
const neteaseInput = document.getElementById('neteaseUrlInput');
const statQueueCount = document.getElementById('statQueueCount');
const statWaitTime = document.getElementById('statWaitTime');

const tabSearch = document.getElementById('tabSearch');
const tabLink = document.getElementById('tabLink');
const searchPanel = document.getElementById('searchPanel');
const linkPanel = document.getElementById('linkPanel');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const queueListCard = document.getElementById('queueListCard');
const queueList = document.getElementById('queueList');

const btnPlayPause = document.getElementById('btnPlayPause');
const playPauseIcon = document.getElementById('playPauseIcon');
const playPauseLabel = document.getElementById('playPauseLabel');
const btnSkip = document.getElementById('btnSkip');
const volumeSlider = document.getElementById('volumeSlider');
const volumeNum = document.getElementById('volumeNum');

const playerPlaylistCard = document.getElementById('playerPlaylistCard');
const playerPlaylistBody = document.getElementById('playerPlaylistBody');
const btnRefreshPlaylist = document.getElementById('btnRefreshPlaylist');
const btnClearPlaylist = document.getElementById('btnClearPlaylist');

let lastState = null;
let lastStateAt = 0;
let volumeDebounce = null;
let playerPlaylistCache = null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showMessage(text, type) {
  messageBox.textContent = text;
  messageBox.className = `rq-message show ${type}`;
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function describeWaitEstimate(estimate) {
  if (!estimate) return '';
  if (estimate.isPlayingNow) return '这首歌正在播放';
  const parts = [];
  if (estimate.aheadQueueCount > 0) parts.push(`前面还有 ${estimate.aheadQueueCount} 首`);
  if (estimate.estimatedWaitMs > 0) parts.push(`预计等待 ${formatDurationMs(estimate.estimatedWaitMs)}`);
  if (estimate.partial) parts.push(`含 ${estimate.unknownDurationCount} 首时长未知`);
  return parts.join('，') || '已加入队列';
}

/* ---------- client-side live interpolation ---------- */

function elapsedSinceUpdate() {
  return lastState ? Date.now() - lastStateAt : 0;
}

function hasPlaylistData() {
  return lastState?.playerPlaylist?.updatedAt > 0;
}

function getLiveRemainingMs() {
  if (hasPlaylistData()) {
    const ms = lastState.playerPlaylist.currentSongRemainingMs || 0;
    return Math.max(0, ms - elapsedSinceUpdate());
  }
  const ms = lastState?.queueTiming?.currentSongRemainingMs;
  if (!ms || ms <= 0) return 0;
  return Math.max(0, ms - elapsedSinceUpdate());
}

function getLiveWaitMs() {
  if (hasPlaylistData()) {
    const ms = lastState.playerPlaylist.nextRequestWaitMs || 0;
    return Math.max(0, ms - elapsedSinceUpdate());
  }
  const ms = lastState?.queueTiming?.nextRequestWaitMs;
  if (!ms || ms <= 0) return 0;
  return Math.max(0, ms - elapsedSinceUpdate());
}

/* ---------- tab switching ---------- */

tabSearch.addEventListener('click', () => {
  tabSearch.classList.add('rq-tab-active');
  tabLink.classList.remove('rq-tab-active');
  searchPanel.style.display = '';
  linkPanel.style.display = 'none';
});

tabLink.addEventListener('click', () => {
  tabLink.classList.add('rq-tab-active');
  tabSearch.classList.remove('rq-tab-active');
  linkPanel.style.display = '';
  searchPanel.style.display = 'none';
});

/* ---------- search ---------- */

async function doSearch() {
  const keyword = searchInput.value.trim();
  if (!keyword) return;
  searchBtn.disabled = true;
  searchBtn.textContent = '搜索中…';
  searchResults.innerHTML = '<div class="rq-results-empty">正在搜索…</div>';
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '搜索失败');
    renderSearchResults(data.results || []);
  } catch (err) {
    searchResults.innerHTML = `<div class="rq-results-empty">${escapeHtml(err.message)}</div>`;
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = '搜索';
  }
}

function renderSearchResults(results) {
  if (!results.length) {
    searchResults.innerHTML = '<div class="rq-results-empty">没有找到结果</div>';
    return;
  }
  searchResults.innerHTML = results.map(song => `
    <div class="rq-result-item">
      <div class="rq-result-info">
        <div class="rq-result-name">${escapeHtml(song.name)}</div>
        <div class="rq-result-meta">${escapeHtml(song.artist)}${song.album ? ' · ' + escapeHtml(song.album) : ''}${song.duration ? ' · ' + escapeHtml(song.duration) : ''}</div>
      </div>
      <button class="rq-btn-pick" data-song-id="${escapeHtml(song.id)}">点歌</button>
    </div>
  `).join('');
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
});

searchResults.addEventListener('click', async (e) => {
  const btn = e.target.closest('.rq-btn-pick');
  if (!btn) return;
  const songId = btn.dataset.songId;
  if (!songId) return;
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const result = await submitRequest({ neteaseUrl: `song:${songId}` });
    const waitText = describeWaitEstimate(result.waitEstimate);
    showMessage(
      result.autoQueued
        ? `已加入队列！${waitText ? waitText + '。' : ''}`
        : '点歌请求已送达主机，等待审核。',
      'success'
    );
    btn.textContent = '已点';
  } catch (err) {
    showMessage(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '点歌';
  }
});

/* ---------- render helpers ---------- */

function renderNowPlaying() {
  const currentSong = lastState?.queueTiming?.currentSong ?? lastState?.nowPlaying ?? null;
  if (!currentSong) {
    nowPlayingBox.className = 'rq-card rq-np-card';
    nowPlayingBox.innerHTML = `
      <div class="rq-card-eyebrow">NOW PLAYING</div>
      <div class="rq-np-empty">暂无播放中的歌曲，可以先提交点歌。</div>
    `;
    return;
  }

  const liveRemaining = getLiveRemainingMs();
  const remainingHtml = liveRemaining > 0
    ? `<div class="rq-np-remaining">还剩 ${formatDurationMs(liveRemaining)}</div>`
    : currentSong.durationText
      ? `<div class="rq-np-remaining">时长 ${escapeHtml(currentSong.durationText)}</div>`
      : '';

  nowPlayingBox.className = 'rq-card rq-np-card rq-np-playing';
  nowPlayingBox.innerHTML = `
    <div class="rq-card-eyebrow">NOW PLAYING</div>
    <div class="rq-np-title">${escapeHtml(currentSong.title || '当前播放')}</div>
    <div class="rq-np-artist">${escapeHtml(currentSong.artist || '未知歌手')}</div>
    ${remainingHtml}
  `;
}

function renderStats() {
  const usePl = hasPlaylistData();
  const queueLength = usePl
    ? (lastState.playerPlaylist.queueLength || 0)
    : (lastState?.queueTiming?.queueLength ?? 0);
  statQueueCount.textContent = queueLength;
  const liveWait = getLiveWaitMs();
  statWaitTime.textContent = liveWait > 0 ? formatDurationMs(liveWait) : '00:00';
}

function renderQueueList() {
  const usePl = hasPlaylistData();
  const waitQueue = usePl ? (lastState.playerPlaylist.waitQueue || []) : [];

  if (!waitQueue.length) {
    queueListCard.style.display = 'none';
    return;
  }
  queueListCard.style.display = '';
  const elapsed = elapsedSinceUpdate();

  let html = '';
  waitQueue.forEach((song, idx) => {
    const liveWait = Math.max(0, (song.waitMs || 0) - elapsed);
    const waitText = liveWait > 0 ? formatDurationMs(liveWait) : '即将播放';
    html += `
      <div class="rq-queue-item">
        <div class="rq-queue-pos">${idx + 1}</div>
        <div class="rq-queue-info">
          <div class="rq-queue-name">${escapeHtml(song.name || '未知歌曲')}</div>
          ${song.artist ? `<div class="rq-queue-meta">${escapeHtml(song.artist)}${song.duration ? ' · ' + escapeHtml(song.duration) : ''}</div>` : ''}
        </div>
        <div class="rq-queue-wait">${waitText}</div>
      </div>
    `;
  });
  queueList.innerHTML = html;
}

function renderControls() {
  const snapshot = lastState?.netease?.playbackSnapshot;
  const isPlaying = snapshot?.isPlaying !== false && snapshot?.title;
  playPauseIcon.textContent = isPlaying ? '⏸' : '▶';
  playPauseLabel.textContent = isPlaying ? '暂停' : '继续';
}

function renderPlayerPlaylistFromState() {
  const pl = lastState?.playerPlaylist;
  if (!pl || !pl.updatedAt || pl.updatedAt <= 0) return;
  const allSongs = pl.all || [];
  if (allSongs.length > 0) {
    playerPlaylistCache = allSongs;
    renderPlayerPlaylist();
  }
}

function renderFull() {
  renderNowPlaying();
  renderStats();
  renderQueueList();
  renderControls();
  renderPlayerPlaylistFromState();
}

/* ---------- player controls ---------- */

btnPlayPause.addEventListener('click', async () => {
  btnPlayPause.disabled = true;
  const snapshot = lastState?.netease?.playbackSnapshot;
  const isPlaying = snapshot?.isPlaying !== false && snapshot?.title;
  // 乐观更新 UI
  if (lastState?.netease?.playbackSnapshot) {
    lastState.netease.playbackSnapshot.isPlaying = !isPlaying;
  }
  renderControls();
  try {
    await fetch(isPlaying ? '/api/player/pause' : '/api/player/resume', { method: 'POST' });
  } catch {}
  btnPlayPause.disabled = false;
});

btnSkip.addEventListener('click', async () => {
  btnSkip.disabled = true;
  try {
    const res = await fetch('/api/player/skip', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) showMessage('切歌失败，请重试', 'error');
  } catch {
    showMessage('切歌失败', 'error');
  }
  setTimeout(() => { btnSkip.disabled = false; }, 2000);
});

volumeSlider.addEventListener('input', () => {
  volumeNum.textContent = volumeSlider.value;
  clearTimeout(volumeDebounce);
  volumeDebounce = setTimeout(async () => {
    try {
      await fetch('/api/player/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: Number(volumeSlider.value) })
      });
    } catch {}
  }, 300);
});

// 初始化音量
(async function initVolume() {
  try {
    const res = await fetch('/api/player/volume');
    const data = await res.json();
    if (data.volume != null) {
      volumeSlider.value = data.volume;
      volumeNum.textContent = data.volume;
    }
  } catch {}
})();

/* ---------- player playlist ---------- */

async function fetchPlayerPlaylist() {
  btnRefreshPlaylist.disabled = true;
  btnRefreshPlaylist.textContent = '…';
  try {
    const res = await fetch('/api/playlist');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');
    playerPlaylistCache = data.songs || [];
    renderPlayerPlaylist();
  } catch (err) {
    playerPlaylistBody.innerHTML = `<div class="rq-results-empty">${escapeHtml(err.message)}</div>`;
  } finally {
    btnRefreshPlaylist.disabled = false;
    btnRefreshPlaylist.textContent = '⟳';
  }
}

function renderPlayerPlaylist() {
  const songs = playerPlaylistCache;
  if (!songs || !songs.length) {
    playerPlaylistBody.innerHTML = '<div class="rq-results-empty">播放列表为空</div>';
    return;
  }
  playerPlaylistBody.innerHTML = songs.map(song => `
    <div class="rq-pl-item${song.isCurrent ? ' rq-pl-current' : ''}" data-song-id="${escapeHtml(song.id)}">
      <div class="rq-pl-indicator">${song.isCurrent ? '♫' : ''}</div>
      <div class="rq-pl-info">
        <div class="rq-pl-name">${escapeHtml(song.name || '未知歌曲')}</div>
        <div class="rq-pl-meta">${escapeHtml(song.artist || '')}${song.duration ? ' · ' + escapeHtml(song.duration) : ''}</div>
      </div>
      <button class="rq-btn-pl-play" data-pl-id="${escapeHtml(song.id)}" title="播放这首"${song.isCurrent ? ' disabled' : ''}>▶</button>
    </div>
  `).join('');
}

btnRefreshPlaylist.addEventListener('click', fetchPlayerPlaylist);

btnClearPlaylist.addEventListener('click', async () => {
  if (!confirm('确定要清除播放列表吗？')) return;
  btnClearPlaylist.disabled = true;
  try {
    const res = await fetch('/api/playlist/clear', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error('清除失败');
    playerPlaylistCache = [];
    renderPlayerPlaylist();
    showMessage('播放列表已清除', 'success');
  } catch (err) {
    showMessage(err.message, 'error');
  } finally {
    btnClearPlaylist.disabled = false;
  }
});

playerPlaylistBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.rq-btn-pl-play');
  if (!btn || btn.disabled) return;
  const songId = btn.dataset.plId;
  if (!songId) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/playlist/play/${songId}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error('播放失败');
    btn.textContent = '✓';
    setTimeout(() => fetchPlayerPlaylist(), 800);
  } catch (err) {
    showMessage(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '▶';
  }
});

/* ---------- data fetching ---------- */

async function loadState() {
  const response = await fetch('/api/state');
  const data = await response.json();
  lastState = data;
  lastStateAt = Date.now();
  renderFull();
}

async function resolveNetease(value) {
  if (!value) {
    neteaseHint.textContent = '支持网易云单曲链接，不接受歌单。';
    return;
  }
  try {
    const response = await fetch(`/api/netease/resolve?url=${encodeURIComponent(value)}`);
    const data = await response.json();
    if (!data.resolved) {
      neteaseHint.textContent = '没有识别出有效的网易云歌曲链接。';
    } else if (data.resolved.type !== 'song') {
      neteaseHint.textContent = '只接受歌曲链接，不接受歌单链接。';
    } else {
      neteaseHint.textContent = `✓ 已识别歌曲 ID：${data.resolved.id}`;
    }
  } catch {
    neteaseHint.textContent = '链接识别失败，请检查格式。';
  }
}

async function submitRequest(payload) {
  const response = await fetch('/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '提交失败');
  return data;
}

/* ---------- form submission ---------- */

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const submitButton = form.querySelector('button[type="submit"]');

  submitButton.disabled = true;
  try {
    const result = await submitRequest(payload);
    form.reset();
    neteaseHint.textContent = '支持网易云单曲链接，不接受歌单。';
    const waitText = describeWaitEstimate(result.waitEstimate);
    showMessage(
      result.autoQueued
        ? `已加入队列！${waitText ? waitText + '。' : ''}`
        : '点歌请求已送达主机，等待审核。',
      'success'
    );
  } catch (error) {
    showMessage(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
});

neteaseInput.addEventListener('blur', () => {
  resolveNetease(neteaseInput.value).catch(() => {
    neteaseHint.textContent = '链接识别失败，请检查格式。';
  });
});

/* ---------- socket + timers ---------- */

socket.on('state:update', (state) => {
  if (state) {
    lastState = state;
    lastStateAt = Date.now();
    renderFull();
  } else {
    loadState().catch(() => {});
  }
});

setInterval(() => {
  if (!lastState) return;
  renderNowPlaying();
  renderStats();
  renderQueueList();
}, 1000);

loadState().catch(() => {
  nowPlayingBox.innerHTML = `
    <div class="rq-card-eyebrow">NOW PLAYING</div>
    <div class="rq-np-empty">状态加载失败，请刷新页面。</div>
  `;
});

fetchPlayerPlaylist();
