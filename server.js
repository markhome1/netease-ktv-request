const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { resolveNeteaseInput } = require('./lib/netease');
const { normalizeBaseUrl, fetchSongUrl, addTrackToPlaylist } = require('./lib/netease-api');
const { createPlaywrightConfig, ensurePage: ensurePlaywrightPage, getStatus: getPlaywrightStatus, getPlaybackSnapshot, openTargetPlaylist, playTargetPlaylist, addSongToPlaylist: addSongToPlaylistWithPlaywright, searchSongs: searchSongsWithPlaywright, clearNetPlayQueue, getPlaylist: getPlaylistFromPlayer, playFromPlaylist: playFromPlayerPlaylist, pausePlayback, resumePlayback, skipToNext, getVolume, setVolume, closeBrowser: closePlaywrightBrowser } = require('./lib/netease-playwright');
const { launchExternalPlayer } = require('./lib/external-player');
const { createOfficialConfig, validateOfficialConfig, explainOfficialMode } = require('./lib/netease-openapi');
const { OFFICIAL_ENDPOINTS } = require('./lib/netease-openapi-endpoints');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function createInitialState() {
  return {
    pendingRequests: [],
    queue: [],
    nowPlaying: null,
    pauseAfterCurrent: false,
    history: [],
    netease: {
      provider: 'third-party-compatible',
      targetPlaylistInput: '',
      targetPlaylistId: '',
      targetPlaylistCanonicalUrl: '',
      apiBaseUrl: '',
      cookie: '',
      autoApproveRequests: false,
      autoResolveSongUrl: false,
      autoSyncPlaylist: false,
      qualityLevel: 'standard',
      syncMode: 'manual-export',
      syncQueue: [],
      playbackSnapshot: null,
      playwright: createPlaywrightConfig(),
      official: createOfficialConfig()
    },
    player: {
      mode: 'browser-audio',
      status: 'idle',
      message: '',
      volume: 1,
      external: {
        enabled: false,
        autoLaunch: false,
        command: '',
        lastLaunchSongId: '',
        lastLaunchAt: null,
        lastCommand: '',
        lastError: ''
      },
      updatedAt: null
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function readState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const initialState = createInitialState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2));
    return initialState;
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const initialState = createInitialState();
    const parsed = JSON.parse(raw);
    return {
      ...initialState,
      ...parsed,
      netease: {
        ...initialState.netease,
        ...(parsed.netease || {}),
        playwright: {
          ...initialState.netease.playwright,
          ...((parsed.netease && parsed.netease.playwright) || {})
        }
      },
      player: {
        ...initialState.player,
        ...(parsed.player || {}),
        external: {
          ...initialState.player.external,
          ...((parsed.player && parsed.player.external) || {})
        }
      }
    };
  } catch {
    const fallback = createInitialState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

let state = readState();

function persistState() {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function broadcastState() {
  io.emit('state:update', buildPublicState());
}

function buildPublicState() {
  return {
    pendingRequests: state.pendingRequests,
    queue: state.queue,
    nowPlaying: state.nowPlaying,
    pauseAfterCurrent: state.pauseAfterCurrent || false,
    history: state.history,
    queueTiming: buildQueueTimingSummary(),
    playerPlaylist: buildPlaylistWaitQueue(),
    netease: state.netease,
    player: state.player,
    updatedAt: state.updatedAt
  };
}

async function refreshPlaybackSnapshot() {
  if (!state.netease.playwright || !state.netease.playwright.enabled) {
    state.netease.playbackSnapshot = null;
    return null;
  }

  try {
    const snapshot = await getPlaybackSnapshot();
    state.netease.playbackSnapshot = snapshot;

    // 用播放器实际读取的时长校正 nowPlaying 的元数据
    // readSongMetadata/readPlaylistSongMetadata 偶尔会读错时长
    if (snapshot && state.nowPlaying && snapshot.durationMs > 0) {
      const stored = state.nowPlaying.durationMs || 0;
      if (Math.abs(stored - snapshot.durationMs) > 5000) {
        state.nowPlaying.durationMs = snapshot.durationMs;
        state.nowPlaying.durationText = snapshot.durationText || formatDurationMs(snapshot.durationMs);
      }
    }

    return snapshot;
  } catch {
    return state.netease.playbackSnapshot || null;
  }
}

// 播放列表缓存：定期从 Playwright 浏览器读取，用于等待队列和查重
let cachedPlayerPlaylist = [];
let cachedPlayerPlaylistAt = 0;
let pollCycleCount = 0;

async function refreshCachedPlaylist() {
  if (!state.netease.playwright?.enabled) {
    cachedPlayerPlaylist = [];
    return;
  }
  try {
    cachedPlayerPlaylist = await getPlaylistFromPlayer();
    cachedPlayerPlaylistAt = Date.now();
  } catch {}
}

function parseDurationTextMs(text) {
  const match = String(text || '').match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}

function buildPlaylistWaitQueue() {
  if (!cachedPlayerPlaylist.length) {
    return { all: [], waitQueue: [], queueLength: 0, nextRequestWaitMs: 0, currentSongRemainingMs: 0, updatedAt: 0 };
  }

  const currentIdx = cachedPlayerPlaylist.findIndex(s => s.isCurrent);
  const afterCurrent = currentIdx >= 0 ? cachedPlayerPlaylist.slice(currentIdx + 1) : [];

  const snapshot = state.netease.playbackSnapshot;
  let cumulative = snapshot && Number.isFinite(snapshot.remainingMs) && snapshot.remainingMs > 0
    ? snapshot.remainingMs : 0;
  const currentSongRemainingMs = cumulative;

  const waitQueue = afterCurrent.map(song => {
    const waitMs = cumulative;
    cumulative += parseDurationTextMs(song.duration);
    return { ...song, waitMs };
  });

  return {
    all: cachedPlayerPlaylist,
    waitQueue,
    queueLength: afterCurrent.length,
    nextRequestWaitMs: cumulative,
    currentSongRemainingMs,
    updatedAt: cachedPlayerPlaylistAt
  };
}

// 自动推进：轮询网易云播放器，检测到切歌则同步服务器队列
let autoAdvancePollTimer = null;
let lastPolledSongId = '';

async function handlePauseAfterCurrent() {
  if (!state.pauseAfterCurrent) return false;
  state.pauseAfterCurrent = false;
  await pausePlayback().catch(() => {});
  persistState();
  broadcastState();
  return true;
}

let playwrightBootstrapped = false;

async function autoAdvancePoll() {
  pollCycleCount++;
  try {
    // 首次轮询时自动启动 Playwright 浏览器（如果已启用）
    if (!playwrightBootstrapped && state.netease.playwright?.enabled) {
      playwrightBootstrapped = true;
      const pwConfig = state.netease.playwright;
      const targetUrl = state.netease.targetPlaylistCanonicalUrl || 'https://music.163.com/';
      try { await ensurePlaywrightPage(__dirname, pwConfig, targetUrl); } catch {}
    }

    if (state.nowPlaying && state.nowPlaying.durationMs && state.nowPlaying.startedAt) {
      const elapsed = Date.now() - new Date(state.nowPlaying.startedAt).getTime();
      if (elapsed > state.nowPlaying.durationMs + 8000 && state.queue.length > 0) {
        if (await handlePauseAfterCurrent()) return;
        await moveQueueToNowPlaying('finished');
        persistState();
        broadcastState();
        return;
      }
    }

    const snapshot = await refreshPlaybackSnapshot();

    // 每 4 个周期（~20s）刷新播放列表缓存
    if (pollCycleCount % 4 === 0) {
      await refreshCachedPlaylist();
    }

    broadcastState();

    if (!snapshot) return;

    const playingSongId = snapshot.songId || '';
    if (!playingSongId) return;

    if (playingSongId === lastPolledSongId) return;
    lastPolledSongId = playingSongId;

    // 切歌了，立即刷新播放列表
    await refreshCachedPlaylist();

    const nowPlayingId = state.nowPlaying?.neteaseResolved?.id;

    if (playingSongId === nowPlayingId) return;

    if (await handlePauseAfterCurrent()) return;

    const queueIdx = state.queue.findIndex(
      (item) => item.neteaseResolved?.id === playingSongId
    );

    if (queueIdx === 0) {
      await moveQueueToNowPlaying('finished');
      persistState();
      broadcastState();
    } else if (queueIdx > 0) {
      for (let i = 0; i < queueIdx; i++) {
        await moveQueueToNowPlaying('skipped');
      }
      persistState();
      broadcastState();
    } else if (!nowPlayingId && state.queue.length > 0) {
      await moveQueueToNowPlaying('finished');
      persistState();
      broadcastState();
    }
  } catch {
  }
}

function startAutoAdvancePolling(intervalMs = 5000) {
  if (autoAdvancePollTimer) clearInterval(autoAdvancePollTimer);
  autoAdvancePollTimer = setInterval(autoAdvancePoll, intervalMs);
}

function stopAutoAdvancePolling() {
  if (autoAdvancePollTimer) {
    clearInterval(autoAdvancePollTimer);
    autoAdvancePollTimer = null;
  }
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getDurationMs(item) {
  return Number.isFinite(item && item.durationMs) && item.durationMs > 0 ? item.durationMs : null;
}

function getRemainingMs(item) {
  if (!item || !item.startedAt) {
    return null;
  }

  const durationMs = getDurationMs(item);
  if (!durationMs) {
    return null;
  }

  const startedAtMs = new Date(item.startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }

  return Math.max(0, durationMs - (Date.now() - startedAtMs));
}

function applySongMetadata(item, metadata) {
  if (!item || !metadata) {
    return;
  }

  if (metadata.title) {
    item.title = metadata.title;
  }
  if (metadata.artist) {
    item.artist = metadata.artist;
  }
  if (Number.isFinite(metadata.durationMs) && metadata.durationMs > 0) {
    item.durationMs = metadata.durationMs;
    item.durationText = metadata.durationText || formatDurationMs(metadata.durationMs);
  }
  item.metadataResolvedAt = new Date().toISOString();
}

function findRequestItemById(id) {
  if (!id) {
    return null;
  }

  if (state.nowPlaying && state.nowPlaying.id === id) {
    return state.nowPlaying;
  }

  return state.queue.find((entry) => entry.id === id)
    || state.pendingRequests.find((entry) => entry.id === id)
    || state.history.find((entry) => entry.id === id)
    || null;
}

function buildWaitEstimateForItem(itemId, queueOverride = state.queue, playbackSnapshot = state.netease.playbackSnapshot) {
  if (state.nowPlaying && state.nowPlaying.id === itemId) {
    return {
      aheadQueueCount: 0,
      estimatedWaitMs: 0,
      estimatedWaitText: '00:00',
      currentSongRemainingMs: playbackSnapshot && Number.isFinite(playbackSnapshot.remainingMs) ? playbackSnapshot.remainingMs : getRemainingMs(state.nowPlaying),
      currentSongRemainingText: playbackSnapshot && playbackSnapshot.remainingText ? playbackSnapshot.remainingText : formatDurationMs(getRemainingMs(state.nowPlaying) || 0),
      unknownDurationCount: 0,
      partial: false,
      isPlayingNow: true
    };
  }

  const targetIndex = queueOverride.findIndex((entry) => entry.id === itemId);
  if (targetIndex === -1) {
    return null;
  }

  // 暂停时整个等待时间归零：播放器停了，下一个请求可以立即开始
  const isPaused = playbackSnapshot && playbackSnapshot.isPlaying === false;
  if (isPaused) {
    return {
      aheadQueueCount: targetIndex,
      estimatedWaitMs: 0,
      estimatedWaitText: '00:00',
      currentSongRemainingMs: 0,
      currentSongRemainingText: '00:00',
      unknownDurationCount: 0,
      partial: false,
      isPlayingNow: false,
      isPaused: true
    };
  }

  let estimatedWaitMs = 0;
  let unknownDurationCount = 0;
  const currentSongRemainingMs = playbackSnapshot && Number.isFinite(playbackSnapshot.remainingMs)
    ? playbackSnapshot.remainingMs
    : getRemainingMs(state.nowPlaying);

  if (currentSongRemainingMs !== null || playbackSnapshot || state.nowPlaying) {
    if (currentSongRemainingMs === null) {
      unknownDurationCount += 1;
    } else {
      estimatedWaitMs += currentSongRemainingMs;
    }
  }

  for (let index = 0; index < targetIndex; index += 1) {
    const durationMs = getDurationMs(queueOverride[index]);
    if (durationMs === null) {
      unknownDurationCount += 1;
    } else {
      estimatedWaitMs += durationMs;
    }
  }

  return {
    aheadQueueCount: targetIndex,
    estimatedWaitMs,
    estimatedWaitText: formatDurationMs(estimatedWaitMs),
    currentSongRemainingMs,
    currentSongRemainingText: playbackSnapshot && playbackSnapshot.remainingText ? playbackSnapshot.remainingText : formatDurationMs(currentSongRemainingMs || 0),
    unknownDurationCount,
    partial: unknownDurationCount > 0,
    isPlayingNow: false
  };
}

function buildQueueTimingSummary() {
  const playbackSnapshot = state.netease.playbackSnapshot;
  const isPaused = playbackSnapshot && playbackSnapshot.isPlaying === false;

  let currentSongRemainingMs = null;
  if (playbackSnapshot && Number.isFinite(playbackSnapshot.remainingMs)) {
    currentSongRemainingMs = playbackSnapshot.remainingMs;
  } else {
    currentSongRemainingMs = getRemainingMs(state.nowPlaying);
  }
  if (currentSongRemainingMs === null) currentSongRemainingMs = 0;
  if (isPaused) currentSongRemainingMs = 0;

  const queueWaits = [];
  let cumulative = currentSongRemainingMs;
  for (const item of state.queue) {
    queueWaits.push({ id: item.id, waitMs: cumulative });
    const dur = getDurationMs(item);
    cumulative += dur || 0;
  }

  return {
    currentSongRemainingMs,
    nextRequestWaitMs: cumulative,
    queueLength: state.queue.length,
    queueWaits,
    isPaused: !!isPaused,
    currentSong: playbackSnapshot || state.nowPlaying || null,
    calculatedAt: Date.now()
  };
}

function buildHostMeta(req) {
  const host = getPreferredHost();
  const baseUrl = `${req.protocol}://${host}:${PORT}`;
  return {
    baseUrl,
    requestUrl: `${baseUrl}/request`,
    adminUrl: `${baseUrl}/admin`
  };
}

function getPreferredHost() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const item of interfaces[name] || []) {
      if (item.family === 'IPv4' && !item.internal) {
        candidates.push(item.address);
      }
    }
  }
  // Prefer standard LAN ranges so VPN/virtual adapters (198.x, etc.) are skipped
  return candidates.find(ip => /^10\./.test(ip))
    || candidates.find(ip => /^192\.168\./.test(ip))
    || candidates.find(ip => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
    || candidates[0]
    || 'localhost';
}

function createSongEntry(payload) {
  const timestamp = new Date().toISOString();
  const neteaseUrl = String(payload.neteaseUrl || '').trim();
  const resolved = resolveNeteaseInput(neteaseUrl);
  const fallbackTitle = resolved && resolved.type === 'song' ? `网易云歌曲 ${resolved.id}` : '未识别歌曲';
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(payload.title || '').trim() || fallbackTitle,
    artist: String(payload.artist || '').trim() || '网易云',
    requester: '扫码用户',
    neteaseUrl,
    neteaseResolved: resolved,
    audioUrl: String(payload.audioUrl || '').trim(),
    note: '',
    status: 'pending',
    createdAt: timestamp,
    approvedAt: null,
    rejectedAt: null
  };
}

function validateSongPayload(payload) {
  const resolved = resolveNeteaseInput(String(payload.neteaseUrl || '').trim());
  if (!resolved || resolved.type !== 'song') {
    return '请提交有效的网易云歌曲链接或 song:123456 这种格式';
  }
  return null;
}

async function resolveSongAudio(item) {
  if (item.audioUrl || !item.neteaseResolved || item.neteaseResolved.type !== 'song') {
    return item;
  }

  if (!state.netease.autoResolveSongUrl || !state.netease.apiBaseUrl) {
    return item;
  }

  try {
    const resolved = await fetchSongUrl(state.netease, item.neteaseResolved.id);
    item.audioUrl = resolved.url;
    item.audioResolvedAt = new Date().toISOString();
    item.audioResolvedBy = resolved.source;
  } catch (error) {
    item.audioResolveError = error.message;
  }

  return item;
}

function queueNeteaseSync(item) {
  if (!item.neteaseResolved || item.neteaseResolved.type !== 'song' || !state.netease.targetPlaylistId) {
    return null;
  }

  const exists = state.netease.syncQueue.find((entry) => entry.sourceRequestId === item.id);
  if (exists) {
    return exists;
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceRequestId: item.id,
    songId: item.neteaseResolved.id,
    canonicalUrl: item.neteaseResolved.canonicalUrl,
    title: item.title,
    artist: item.artist,
    requester: item.requester,
    status: 'pending-manual',
    createdAt: new Date().toISOString()
  };

  state.netease.syncQueue.unshift(entry);
  state.netease.syncQueue = state.netease.syncQueue.slice(0, 100);
  return entry;
}

async function tryAutoSyncQueueEntry(entry) {
  if (!entry) return null;

  const playwrightEnabled = state.netease.playwright && state.netease.playwright.enabled;

  // Playwright 启用时：无论 autoSyncPlaylist 开关，都自动同步到歌单并控制播放
  // autoSyncPlaylist 仅控制非 Playwright 的 API 同步路径
  if (!playwrightEnabled && !state.netease.autoSyncPlaylist) {
    return null;
  }

  if (playwrightEnabled) {
    // 先刷新一次播放状态，确保 shouldTriggerPlayback 判断准确
    await refreshPlaybackSnapshot().catch(() => null);

    const snapshot = state.netease.playbackSnapshot;
    // "真正在播" = 有标题 AND elapsed > 3秒 AND isPlaying 不是 false
    const neteaseIsActuallyPlaying = snapshot?.title
      && Number.isFinite(snapshot.elapsedMs)
      && snapshot.elapsedMs > 3000
      && snapshot.isPlaying !== false;

    // 正在播放 → 只加队列不打断；没在播放 → 直接播放
    const shouldTriggerPlayback = !neteaseIsActuallyPlaying;

    // 没在播放且队列之前是空的 → 先清旧播放列表再添加，避免新歌排在旧歌后面
    if (shouldTriggerPlayback) {
      const otherQueueItems = state.queue.filter(q => q.id !== entry.sourceRequestId).length;
      if (otherQueueItems === 0) {
        await clearNetPlayQueue().catch(err =>
          console.warn(`[tryAutoSyncQueueEntry] 清空播放列表失败: ${err.message}`)
        );
      }
    }

    try {
      const result = await addSongToPlaylistWithPlaywright(__dirname, state.netease.playwright, {
        songId: entry.songId,
        songUrl: entry.canonicalUrl,
        playlistId: state.netease.targetPlaylistId,
        playlistUrl: state.netease.targetPlaylistCanonicalUrl,
        playlistName: state.netease.playwright.targetPlaylistName || '',
        title: entry.title,
        artist: entry.artist,
        shouldTriggerPlayback
      });
      entry.status = 'synced-playwright';
      entry.updatedAt = new Date().toISOString();
      entry.syncedAt = new Date().toISOString();
      applySongMetadata(entry, result.song);
      applySongMetadata(findRequestItemById(entry.sourceRequestId), result.song);
      entry.syncMessage = result.playbackTriggered
        ? `已通过 Playwright 写入歌单 ${result.playlistName} 并播放`
        : `已通过 Playwright 写入歌单 ${result.playlistName}（排队等待）`;

      state.netease.playwright = createPlaywrightConfig({
        ...state.netease.playwright,
        targetPlaylistName: result.playlistName,
        lastError: '',
        lastAction: 'sync-song',
        lastActionAt: new Date().toISOString()
      });

      // 同步成功后刷新播放列表缓存
      await refreshCachedPlaylist();
    } catch (error) {
      entry.status = 'failed-playwright';
      entry.updatedAt = new Date().toISOString();
      entry.syncMessage = error.message;
      state.netease.playwright = createPlaywrightConfig({
        ...state.netease.playwright,
        lastError: error.message,
        lastAction: 'sync-song-failed',
        lastActionAt: new Date().toISOString()
      });
    }
    return entry;
  }

  // API 同步（仅在 autoSyncPlaylist 明确开启时走）
  if (!state.netease.autoSyncPlaylist) {
    return entry;
  }

  try {
    await addTrackToPlaylist(state.netease, state.netease.targetPlaylistId, entry.songId);
    entry.status = 'synced';
    entry.updatedAt = new Date().toISOString();
    entry.syncedAt = new Date().toISOString();
    entry.syncMessage = '已自动写入目标歌单';
  } catch (error) {
    entry.status = 'failed-auto';
    entry.updatedAt = new Date().toISOString();
    entry.syncMessage = error.message;
  }

  return entry;
}

async function approveRequestItem(item) {
  item.status = 'approved';
  item.approvedAt = new Date().toISOString();
  state.pendingRequests = state.pendingRequests.filter((entry) => entry.id !== item.id);
  await resolveSongAudio(item);
  state.queue.push(item);
  const syncEntry = queueNeteaseSync(item);
  await tryAutoSyncQueueEntry(syncEntry);

  if (!state.nowPlaying) {
    await moveQueueToNowPlaying();
  }

  const playbackSnapshot = await refreshPlaybackSnapshot();
  const waitEstimate = buildWaitEstimateForItem(item.id, state.queue, playbackSnapshot);

  return {
    item,
    syncEntry,
    waitEstimate
  };
}

function updatePlayerState(patch) {
  state.player = {
    ...state.player,
    ...patch,
    external: {
      ...state.player.external,
      ...(patch.external || {})
    },
    updatedAt: new Date().toISOString()
  };
}

function tryLaunchExternalPlayer(item, options = {}) {
  const force = Boolean(options.force);
  if (!state.player.external.enabled || (!force && !state.player.external.autoLaunch)) {
    return;
  }

  try {
    const result = launchExternalPlayer(state.player.external, item);
    updatePlayerState({
      status: 'external-launched',
      message: '已触发外部播放器启动',
      external: {
        lastLaunchSongId: item.id,
        lastLaunchAt: new Date().toISOString(),
        lastCommand: result.command,
        lastError: ''
      }
    });
  } catch (error) {
    updatePlayerState({
      status: 'external-launch-failed',
      message: error.message,
      external: {
        lastError: error.message
      }
    });
  }
}

async function moveQueueToNowPlaying(transitionStatus = 'finished') {
  if (state.queue.length === 0) {
    state.nowPlaying = null;
    updatePlayerState({
      status: 'idle',
      message: '队列为空'
    });
    return null;
  }

  const nextSong = state.queue.shift();
  nextSong.startedAt = new Date().toISOString();
  nextSong.status = 'playing';

  if (state.nowPlaying) {
    const transitionKey = transitionStatus === 'skipped' ? 'skippedAt' : 'finishedAt';
    state.history.unshift({
      ...state.nowPlaying,
      [transitionKey]: new Date().toISOString(),
      status: transitionStatus
    });
    state.history = state.history.slice(0, 20);
  }

  state.nowPlaying = nextSong;
  await resolveSongAudio(nextSong);
  updatePlayerState({
    status: nextSong.audioUrl ? 'ready' : 'waiting-source',
    message: nextSong.audioUrl ? '等待主机播放器开始' : (nextSong.audioResolveError || '当前歌曲缺少可播放链接')
  });
  tryLaunchExternalPlayer(nextSong);
  return nextSong;
}

app.get('/', (req, res) => {
  res.redirect('/admin');
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/request', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'request.html'));
});

app.get('/api/state', (req, res) => {
  refreshPlaybackSnapshot()
    .catch(() => null)
    .finally(() => {
      res.json(buildPublicState());
    });
});

app.get('/api/meta', async (req, res) => {
  const meta = buildHostMeta(req);
  const qrSvg = await QRCode.toString(meta.requestUrl, {
    type: 'svg',
    margin: 1,
    width: 256
  });
  res.json({ ...meta, qrSvg });
});

app.get('/api/netease/resolve', (req, res) => {
  const resolved = resolveNeteaseInput(req.query.url);
  res.json({ resolved });
});

app.get('/api/netease/export', (req, res) => {
  const lines = state.netease.syncQueue.map((entry) => `${entry.title} - ${entry.artist} | ${entry.canonicalUrl}`);
  res.json({
    targetPlaylistId: state.netease.targetPlaylistId,
    targetPlaylistCanonicalUrl: state.netease.targetPlaylistCanonicalUrl,
    count: state.netease.syncQueue.length,
    lines
  });
});

app.get('/api/netease/official-info', (req, res) => {
  const validation = validateOfficialConfig(state.netease.official || createOfficialConfig());
  res.json({
    official: state.netease.official,
    validation,
    endpoints: OFFICIAL_ENDPOINTS,
    explanation: explainOfficialMode(state.netease.official || createOfficialConfig())
  });
});

app.get('/api/netease/playwright-status', async (req, res) => {
  const status = await getPlaywrightStatus(__dirname, state.netease.playwright || createPlaywrightConfig(), state.netease.targetPlaylistCanonicalUrl);
  state.netease.playbackSnapshot = status.playerSnapshot || null;
  res.json({
    config: state.netease.playwright,
    status
  });
});

app.post('/api/requests', async (req, res) => {
  const error = validateSongPayload(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  // 查重：检查歌曲是否已在播放列表的等待队列中
  const resolved = resolveNeteaseInput(String(req.body.neteaseUrl || '').trim());
  if (resolved && resolved.type === 'song' && cachedPlayerPlaylist.length > 0) {
    const currentIdx = cachedPlayerPlaylist.findIndex(s => s.isCurrent);
    const upcoming = currentIdx >= 0 ? cachedPlayerPlaylist.slice(currentIdx) : cachedPlayerPlaylist;
    if (upcoming.some(s => s.id === resolved.id)) {
      return res.status(400).json({ error: '这首歌已在播放列表中，无需重复点歌' });
    }
  }

  const requestItem = createSongEntry(req.body);

  if (state.netease.autoApproveRequests) {
    const result = await approveRequestItem(requestItem);
    persistState();
    broadcastState();
    res.status(201).json({
      ok: true,
      request: result.item,
      autoQueued: true,
      syncStatus: result.syncEntry ? result.syncEntry.status : null,
      waitEstimate: result.waitEstimate
    });
    return;
  }

  state.pendingRequests.unshift(requestItem);
  persistState();
  broadcastState();
  res.status(201).json({ ok: true, request: requestItem, autoQueued: false });
});

app.post('/api/config/netease-adapter', (req, res) => {
  state.netease = {
    ...state.netease,
    provider: 'third-party-compatible',
    apiBaseUrl: normalizeBaseUrl(req.body.apiBaseUrl),
    cookie: String(req.body.cookie || '').trim(),
    autoApproveRequests: Boolean(req.body.autoApproveRequests),
    autoResolveSongUrl: Boolean(req.body.autoResolveSongUrl),
    autoSyncPlaylist: Boolean(req.body.autoSyncPlaylist),
    qualityLevel: String(req.body.qualityLevel || state.netease.qualityLevel || 'standard').trim() || 'standard',
    syncMode: Boolean(req.body.autoSyncPlaylist) ? 'auto-api' : 'manual-export'
  };
  persistState();
  broadcastState();
  res.json({ ok: true, netease: state.netease });
});

app.post('/api/config/netease-official', (req, res) => {
  state.netease = {
    ...state.netease,
    provider: 'official-openapi',
    official: createOfficialConfig(req.body)
  };
  persistState();
  broadcastState();
  res.json({
    ok: true,
    netease: state.netease,
    validation: validateOfficialConfig(state.netease.official)
  });
});

app.post('/api/config/netease-playlist', (req, res) => {
  const input = String(req.body.input || '').trim();
  const resolved = resolveNeteaseInput(input);
  if (input && (!resolved || resolved.type !== 'playlist')) {
    res.status(400).json({ error: '请输入有效的网易云歌单链接或 playlist:123 格式' });
    return;
  }

  state.netease.targetPlaylistInput = input;
  state.netease.targetPlaylistId = resolved ? resolved.id : '';
  state.netease.targetPlaylistCanonicalUrl = resolved ? resolved.canonicalUrl : '';
  persistState();
  broadcastState();
  res.json({ ok: true, netease: state.netease });
});

app.post('/api/config/netease-playwright', (req, res) => {
  state.netease.playwright = createPlaywrightConfig({
    ...state.netease.playwright,
    ...req.body
  });
  // 根据 enabled 动态启停自动推进轮询
  if (state.netease.playwright.enabled) {
    startAutoAdvancePolling();
  } else {
    stopAutoAdvancePolling();
  }
  persistState();
  broadcastState();
  res.json({ ok: true, playwright: state.netease.playwright });
});

app.post('/api/player/pause', async (req, res) => {
  const ok = await pausePlayback();
  await refreshPlaybackSnapshot().catch(() => null);
  broadcastState();
  res.json({ ok });
});

app.post('/api/player/resume', async (req, res) => {
  const ok = await resumePlayback();
  await refreshPlaybackSnapshot().catch(() => null);
  broadcastState();
  res.json({ ok });
});

app.post('/api/player/skip', async (req, res) => {
  const ok = await skipToNext();
  // 等网易云切歌完成再刷新
  await new Promise(r => setTimeout(r, 800));
  await refreshPlaybackSnapshot().catch(() => null);
  broadcastState();
  res.json({ ok });
});

app.get('/api/player/volume', async (req, res) => {
  const vol = await getVolume();
  res.json({ ok: true, volume: vol });
});

app.post('/api/player/volume', async (req, res) => {
  const vol = Number(req.body.volume);
  if (!Number.isFinite(vol) || vol < 0 || vol > 100) {
    return res.status(400).json({ error: '音量范围 0-100' });
  }
  const ok = await setVolume(vol);
  res.json({ ok, volume: vol });
});

app.post('/api/search', async (req, res) => {
  const keyword = String(req.body.keyword || '').trim();
  if (!keyword) {
    return res.status(400).json({ error: '请输入搜索关键词' });
  }
  if (!state.netease.playwright?.enabled) {
    return res.status(400).json({ error: 'Playwright 尚未启用，请在管理后台开启' });
  }
  try {
    const results = await searchSongsWithPlaywright(__dirname, state.netease.playwright, keyword);
    res.json({ ok: true, keyword, results });
  } catch (error) {
    res.status(500).json({ error: `搜索失败：${error.message}` });
  }
});

app.get('/api/playlist', async (req, res) => {
  if (!state.netease.playwright?.enabled) {
    return res.status(400).json({ error: 'Playwright 尚未启用' });
  }
  try {
    const songs = await getPlaylistFromPlayer();
    cachedPlayerPlaylist = songs;
    cachedPlayerPlaylistAt = Date.now();
    broadcastState();
    res.json({ ok: true, songs });
  } catch (error) {
    res.status(500).json({ error: `读取播放列表失败：${error.message}` });
  }
});

app.post('/api/playlist/play/:songId', async (req, res) => {
  if (!state.netease.playwright?.enabled) {
    return res.status(400).json({ error: 'Playwright 尚未启用' });
  }
  try {
    const ok = await playFromPlayerPlaylist(req.params.songId);
    if (ok) {
      await new Promise(r => setTimeout(r, 600));
      await refreshPlaybackSnapshot().catch(() => null);
      broadcastState();
    }
    res.json({ ok });
  } catch (error) {
    res.status(500).json({ error: `播放失败：${error.message}` });
  }
});

app.post('/api/playlist/clear', async (req, res) => {
  if (!state.netease.playwright?.enabled) {
    return res.status(400).json({ error: 'Playwright 尚未启用' });
  }
  try {
    const ok = await clearNetPlayQueue();
    if (ok) {
      await refreshPlaybackSnapshot().catch(() => null);
      broadcastState();
    }
    res.json({ ok });
  } catch (error) {
    res.status(500).json({ error: `清除失败：${error.message}` });
  }
});

app.post('/api/netease/playwright/launch', async (req, res) => {
  try {
    const result = await openTargetPlaylist(__dirname, state.netease.playwright || createPlaywrightConfig(), state.netease.targetPlaylistCanonicalUrl);
    state.netease.playwright = createPlaywrightConfig({
      ...state.netease.playwright,
      targetPlaylistName: result.playlistName || state.netease.playwright.targetPlaylistName,
      lastError: '',
      lastAction: 'launch',
      lastActionAt: new Date().toISOString()
    });
    persistState();
    broadcastState();
    res.json({ ok: true, result, playwright: state.netease.playwright });
  } catch (error) {
    state.netease.playwright = createPlaywrightConfig({
      ...state.netease.playwright,
      lastError: error.message,
      lastAction: 'launch-failed',
      lastActionAt: new Date().toISOString()
    });
    persistState();
    broadcastState();
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/netease/playwright/open-playlist', async (req, res) => {
  try {
    const result = await openTargetPlaylist(__dirname, state.netease.playwright || createPlaywrightConfig(), state.netease.targetPlaylistCanonicalUrl);
    state.netease.playwright = createPlaywrightConfig({
      ...state.netease.playwright,
      targetPlaylistName: result.playlistName || state.netease.playwright.targetPlaylistName,
      lastError: '',
      lastAction: 'open-playlist',
      lastActionAt: new Date().toISOString()
    });
    persistState();
    broadcastState();
    res.json({ ok: true, result, playwright: state.netease.playwright });
  } catch (error) {
    state.netease.playwright = createPlaywrightConfig({
      ...state.netease.playwright,
      lastError: error.message,
      lastAction: 'open-playlist-failed',
      lastActionAt: new Date().toISOString()
    });
    persistState();
    broadcastState();
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/netease/playwright/play-playlist', async (req, res) => {
  try {
    const result = await playTargetPlaylist(__dirname, state.netease.playwright || createPlaywrightConfig(), state.netease.targetPlaylistCanonicalUrl);
    state.netease.playwright = createPlaywrightConfig({
      ...state.netease.playwright,
      targetPlaylistName: result.playlistName || state.netease.playwright.targetPlaylistName,
      lastError: '',
      lastAction: 'play-playlist',
      lastActionAt: new Date().toISOString()
    });
    persistState();
    broadcastState();
    res.json({ ok: true, result, playwright: state.netease.playwright });
  } catch (error) {
    state.netease.playwright = createPlaywrightConfig({
      ...state.netease.playwright,
      lastError: error.message,
      lastAction: 'play-playlist-failed',
      lastActionAt: new Date().toISOString()
    });
    persistState();
    broadcastState();
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/netease/playwright/close', async (req, res) => {
  await closePlaywrightBrowser();
  state.netease.playwright = createPlaywrightConfig({
    ...state.netease.playwright,
    lastError: '',
    lastAction: 'close',
    lastActionAt: new Date().toISOString()
  });
  persistState();
  broadcastState();
  res.json({ ok: true, playwright: state.netease.playwright });
});

app.post('/api/config/player-external', (req, res) => {
  const enabled = Boolean(req.body.enabled);
  const autoLaunch = Boolean(req.body.autoLaunch);
  const command = String(req.body.command || '').trim();

  updatePlayerState({
    external: {
      ...state.player.external,
      enabled,
      autoLaunch,
      command,
      lastError: ''
    }
  });

  persistState();
  broadcastState();
  res.json({ ok: true, player: state.player });
});

app.post('/api/requests/:id/approve', async (req, res) => {
  const item = state.pendingRequests.find((entry) => entry.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: '未找到请求' });
    return;
  }

  await approveRequestItem(item);

  persistState();
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/requests/:id/reject', (req, res) => {
  const item = state.pendingRequests.find((entry) => entry.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: '未找到请求' });
    return;
  }

  item.status = 'rejected';
  item.rejectedAt = new Date().toISOString();
  state.pendingRequests = state.pendingRequests.filter((entry) => entry.id !== item.id);
  persistState();
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/player/next', async (req, res) => {
  await moveQueueToNowPlaying('skipped');
  persistState();
  broadcastState();
  res.json({ ok: true, nowPlaying: state.nowPlaying });
});

app.post('/api/player/status', (req, res) => {
  updatePlayerState({
    status: String(req.body.status || state.player.status),
    message: String(req.body.message || ''),
    volume: typeof req.body.volume === 'number' ? req.body.volume : state.player.volume
  });
  persistState();
  broadcastState();
  res.json({ ok: true, player: state.player });
});

app.post('/api/player/launch-external', (req, res) => {
  if (!state.nowPlaying) {
    res.status(400).json({ error: '当前没有播放中的歌曲' });
    return;
  }

  tryLaunchExternalPlayer(state.nowPlaying, { force: true });
  persistState();
  broadcastState();
  res.json({ ok: true, player: state.player });
});

app.post('/api/sync/:id/mark', (req, res) => {
  const item = state.netease.syncQueue.find((entry) => entry.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: '未找到同步条目' });
    return;
  }

  const status = String(req.body.status || '').trim();
  if (!['synced', 'ignored'].includes(status)) {
    res.status(400).json({ error: '状态不合法' });
    return;
  }

  item.status = status;
  item.updatedAt = new Date().toISOString();
  persistState();
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/sync/:id/retry-auto', async (req, res) => {
  const item = state.netease.syncQueue.find((entry) => entry.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: '未找到同步条目' });
    return;
  }

  await tryAutoSyncQueueEntry(item);
  persistState();
  broadcastState();
  res.json({ ok: true, item });
});

app.post('/api/player/clear', (req, res) => {
  state.pendingRequests = [];
  state.queue = [];
  state.nowPlaying = null;
  state.history = [];
  state.player.status = 'idle';
  state.player.message = '已清空';
  state.player.updatedAt = new Date().toISOString();
  // 清掉 playback 快照，避免界面还显示旧歌；重置轮询游标让下一首能正常识别
  state.netease.playbackSnapshot = null;
  lastPolledSongId = '';
  persistState();
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/queue/:id/remove', (req, res) => {
  const before = state.queue.length;
  state.queue = state.queue.filter((entry) => entry.id !== req.params.id);
  if (state.queue.length === before) {
    res.status(404).json({ error: '未找到队列歌曲' });
    return;
  }
  persistState();
  broadcastState();
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('state:update', buildPublicState());
});

server.listen(PORT, () => {
  const host = getPreferredHost();
  console.log(`music-scanplayer listening on http://${host}:${PORT}`);
  console.log(`admin page: http://${host}:${PORT}/admin`);
  console.log(`request page: http://${host}:${PORT}/request`);

  // 如果 Playwright 已启用，启动自动推进轮询
  if (state.netease.playwright && state.netease.playwright.enabled) {
    startAutoAdvancePolling();
    console.log('auto-advance polling started (5s interval)');
  }
});
