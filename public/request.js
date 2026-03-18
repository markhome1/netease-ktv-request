const socket = io();

const form = document.getElementById('requestForm');
const messageBox = document.getElementById('formMessage');
const nowPlayingBox = document.getElementById('nowPlayingBox');
const neteaseHint = document.getElementById('neteaseHint');
const neteaseInput = document.getElementById('neteaseUrlInput');
const statQueueCount = document.getElementById('statQueueCount');
const statWaitTime = document.getElementById('statWaitTime');

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

function renderState(state) {
  const currentSong = state.queueTiming?.currentSong ?? state.nowPlaying ?? null;
  const nextRequest = state.queueTiming?.nextRequest ?? null;
  const queueLength = typeof state.queueTiming?.queueLength === 'number' ? state.queueTiming.queueLength : 0;

  // Update stat cards
  statQueueCount.textContent = queueLength;
  if (nextRequest?.estimatedWaitText && nextRequest.estimatedWaitText !== '00:00') {
    statWaitTime.textContent = nextRequest.estimatedWaitText;
  } else {
    statWaitTime.textContent = '00:00';
  }

  // Update now playing card
  if (!currentSong) {
    nowPlayingBox.className = 'rq-card rq-np-card';
    nowPlayingBox.innerHTML = `
      <div class="rq-card-eyebrow">NOW PLAYING</div>
      <div class="rq-np-empty">暂无播放中的歌曲，可以先提交点歌。</div>
    `;
    return;
  }

  const remainingHtml = currentSong.remainingText
    ? `<div class="rq-np-remaining">还剩 ${escapeHtml(currentSong.remainingText)}</div>`
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

async function loadState() {
  const response = await fetch('/api/state');
  const data = await response.json();
  renderState(data);
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

socket.on('state:update', (state) => {
  if (state) {
    renderState(state);
  } else {
    loadState().catch(() => {});
  }
});

loadState().catch(() => {
  nowPlayingBox.innerHTML = `
    <div class="rq-card-eyebrow">NOW PLAYING</div>
    <div class="rq-np-empty">状态加载失败，请刷新页面。</div>
  `;
});
