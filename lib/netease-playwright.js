const path = require('path');

let playwrightRuntime = {
  context: null,
  page: null,
  playlistName: '',
  launchedAt: null
};

function createPlaywrightConfig(input = {}) {
  return {
    enabled: Boolean(input.enabled),
    headless: Boolean(input.headless),
    autoPlayAfterSync: input.autoPlayAfterSync === undefined ? true : Boolean(input.autoPlayAfterSync),
    browserChannel: String(input.browserChannel || '').trim(),
    userDataDir: String(input.userDataDir || 'data/playwright-profile').trim() || 'data/playwright-profile',
    targetPlaylistName: String(input.targetPlaylistName || '').trim(),
    lastError: String(input.lastError || '').trim(),
    lastAction: String(input.lastAction || '').trim(),
    lastActionAt: input.lastActionAt || null
  };
}

function resolveUserDataDir(rootDir, config) {
  const configured = String(config.userDataDir || 'data/playwright-profile').trim();
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
}

async function getPlaywrightModule() {
  return require('playwright');
}

async function closeBrowser() {
  if (playwrightRuntime.context) {
    try {
      await playwrightRuntime.context.close();
    } catch {
    }
  }

  playwrightRuntime = {
    context: null,
    page: null,
    playlistName: '',
    launchedAt: null
  };
}

function resetRuntime() {
  playwrightRuntime = {
    context: null,
    page: null,
    playlistName: '',
    launchedAt: null
  };
}

async function isContextAlive() {
  if (!playwrightRuntime.context) {
    return false;
  }

  try {
    playwrightRuntime.context.pages();
    return true;
  } catch {
    resetRuntime();
    return false;
  }
}

async function ensurePage(rootDir, config, targetUrl) {
  if (await isContextAlive()) {
    try {
      if (playwrightRuntime.page && !playwrightRuntime.page.isClosed()) {
        if (targetUrl) {
          await playwrightRuntime.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        }
        return playwrightRuntime.page;
      }

      const pages = playwrightRuntime.context.pages();
      playwrightRuntime.page = pages[0] || await playwrightRuntime.context.newPage();
      if (targetUrl) {
        await playwrightRuntime.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      }
      return playwrightRuntime.page;
    } catch {
      resetRuntime();
    }
  }

  const { chromium } = await getPlaywrightModule();
  const launchOptions = {
    headless: Boolean(config.headless),
    viewport: null,
    args: ['--start-maximized']
  };

  if (config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  const context = await chromium.launchPersistentContext(resolveUserDataDir(rootDir, config), launchOptions);
  const page = context.pages()[0] || await context.newPage();
  playwrightRuntime = {
    context,
    page,
    playlistName: config.targetPlaylistName || '',
    launchedAt: new Date().toISOString()
  };

  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  }

  return page;
}

async function getMusicFrame(page) {
  await page.waitForLoadState('domcontentloaded');
  const frameHandle = await page.$('#g_iframe');
  if (!frameHandle) {
    return null;
  }
  return frameHandle.contentFrame();
}

async function discoverPlaylistName(page) {
  const frame = await getMusicFrame(page);
  const contexts = [frame, page].filter(Boolean);

  for (const context of contexts) {
    const candidates = [
      'h2.f-ff2',
      'h2.u-title',
      '.tit h2',
      'h2'
    ];

    for (const selector of candidates) {
      try {
        const locator = context.locator(selector).first();
        const text = (await locator.textContent({ timeout: 1500 })) || '';
        const normalized = text.trim();
        if (normalized) {
          return normalized;
        }
      } catch {
      }
    }
  }

  const title = await page.title();
  return title.replace(/_.*$/, '').trim();
}

async function openTargetPlaylist(rootDir, config, playlistUrl) {
  const targetUrl = playlistUrl || 'https://music.163.com/#/my/m/music/playlist';
  const page = await ensurePage(rootDir, config, targetUrl);
  await page.bringToFront();
  await page.waitForTimeout(1200);
  const playlistName = await discoverPlaylistName(page);
  if (playlistName) {
    playwrightRuntime.playlistName = playlistName;
  }

  return {
    pageUrl: page.url(),
    playlistName: playwrightRuntime.playlistName || playlistName || ''
  };
}

// 确保底部播放栏真正开始播放：若处于暂停状态则点击播放键
// 网易云：暂停时按钮为 a.ply.j-flag[data-action="play"]（无 pas 类）
//        播放时按钮为 a.ply.j-flag.pas[data-action="pause"]
// expectedSongId: 若提供，则先确认播放栏显示的是目标歌曲再点播放，避免播错歌
async function ensurePlaybackStarted(page, expectedSongId) {
  try {
    // 若指定了目标歌曲 ID，先检查播放栏当前歌曲
    if (expectedSongId) {
      const nameLink = page.locator('.j-flag.words .name, .m-playbar .words .name').first();
      const href = await nameLink.getAttribute('href', { timeout: 1500 }).catch(() => '');
      if (href && !href.includes(expectedSongId)) {
        // 播放栏里不是目标歌曲，不要强行点播放（避免播错歌）
        return false;
      }
    }
    // 等最多 2 秒，看播放栏是否出现"暂停态"播放按钮
    const playBtn = page.locator('a.ply.j-flag:not(.pas)[data-action="play"]').first();
    await playBtn.waitFor({ state: 'visible', timeout: 2000 });
    await playBtn.click();
    await page.waitForTimeout(600);
    return true;
  } catch {
    return false;
  }
}

async function playTargetPlaylist(rootDir, config, playlistUrl) {
  const opened = await openTargetPlaylist(rootDir, config, playlistUrl);
  const page = playwrightRuntime.page;
  const frame = await getMusicFrame(page);
  const contexts = [frame, page].filter(Boolean);

  for (const context of contexts) {
    try {
      const locator = context.locator('#flag_play').first();
      await locator.waitFor({ state: 'visible', timeout: 2500 });
      await locator.click();
      await page.waitForTimeout(800);
      await ensurePlaybackStarted(page);
      return {
        ...opened,
        played: true
      };
    } catch {
    }

    try {
      const locator = context.locator('a.u-btni-addply[data-res-action="play"]').first();
      await locator.waitFor({ state: 'visible', timeout: 2000 });
      await locator.click();
      await page.waitForTimeout(800);
      await ensurePlaybackStarted(page);
      return {
        ...opened,
        played: true
      };
    } catch {
    }
  }

  // 最后兜底：直接点播放栏的播放按钮
  const started = await ensurePlaybackStarted(page);
  if (started) {
    return { ...opened, played: true };
  }

  throw new Error('没有在共享歌单页面找到播放按钮 #flag_play');
}

// 精准播放：在歌单里找到指定 songId 的行并双击，让网易云从这首开始播
async function playSpecificSongInPlaylist(rootDir, config, playlistUrl, songId) {
  const opened = await openTargetPlaylist(rootDir, config, playlistUrl);
  const page = playwrightRuntime.page;

  // 等歌单行渲染：等到至少有一首歌出现在 DOM 里
  const frame = await getMusicFrame(page);
  const contexts = [frame, page].filter(Boolean);

  // 先等歌单表格出现（最多 8 秒）
  for (const context of contexts) {
    try {
      await context.locator('table.m-table tbody tr, tr[id]').first().waitFor({ state: 'visible', timeout: 8000 });
      break;
    } catch { }
  }
  await page.waitForTimeout(500);

  if (songId) {
    for (const context of contexts) {
      // 方案 1：直接点歌曲行里的 span.ply[data-res-id][data-res-action="play"]
      // 这是每首歌专属的播放触发元素，点击后网易云立即切换并播放该曲
      try {
        const plyBtn = context.locator(`span[data-res-id="${songId}"][data-res-action="play"]`).first();
        await plyBtn.waitFor({ state: 'attached', timeout: 5000 });
        // 先把鼠标移到所在行让按钮变为可见
        const row = context.locator(`tr:has(span[data-res-id="${songId}"])`).first();
        await row.hover().catch(() => {});
        await page.waitForTimeout(300);
        await plyBtn.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(1200);
        // 点完行播放键后确保底部播放栏也处于播放状态
        await ensurePlaybackStarted(page);
        return { ...opened, played: true, method: 'span-ply-click' };
      } catch {
      }

      // 方案 2：双击整行（兜底）
      for (const rowSel of [
        `tr:has([data-res-id="${songId}"])`,
        `tr[data-res-id="${songId}"]`
      ]) {
        try {
          const row = context.locator(rowSel).first();
          await row.waitFor({ state: 'visible', timeout: 3000 });
          await row.dblclick();
          await page.waitForTimeout(1200);
          await ensurePlaybackStarted(page);
          return { ...opened, played: true, method: 'dblclick-row' };
        } catch {
        }
      }
    }
  }

  // 兜底：点"播放全部"
  return playTargetPlaylist(rootDir, config, playlistUrl);
}

async function getLoginState() {
  if (!(await isContextAlive())) {
    return {
      loggedIn: false,
      cookieNames: []
    };
  }

  const cookies = await playwrightRuntime.context.cookies('https://music.163.com');
  const cookieNames = cookies.map((item) => item.name);
  const loggedIn = cookieNames.includes('MUSIC_U') || cookieNames.includes('__csrf');

  return {
    loggedIn,
    cookieNames
  };
}

async function readFirstAvailableAttr(contexts, selectors, attributeName) {
  for (const context of contexts) {
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        const value = await locator.getAttribute(attributeName, { timeout: 1200 });
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        if (normalized) {
          return normalized;
        }
      } catch {
      }
    }
  }

  return '';
}

async function readProgressPercent(contexts, selectors) {
  for (const context of contexts) {
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        const style = await locator.getAttribute('style', { timeout: 1200 });
        const match = String(style || '').match(/width\s*:\s*([\d.]+)%/i);
        if (match) {
          return Number(match[1]);
        }
      } catch {
      }
    }
  }

  return null;
}

async function getPlaybackSnapshot() {
  if (!(await isContextAlive()) || !playwrightRuntime.page || playwrightRuntime.page.isClosed()) {
    return null;
  }

  const page = playwrightRuntime.page;
  const frame = await getMusicFrame(page).catch(() => null);
  const contexts = [page, frame].filter(Boolean);
  const title = await readFirstAvailableAttr(contexts, [
    '.j-flag.words .name',
    '.m-playbar .words .name',
    '.words .name'
  ], 'title');
  const artist = await readFirstAvailableAttr(contexts, [
    '.j-flag.words .by span[title]',
    '.j-flag.words .by [title]',
    '.m-playbar .words .by [title]',
    '.words .by [title]'
  ], 'title');
  const songHref = await readFirstAvailableAttr(contexts, [
    '.j-flag.words .name',
    '.m-playbar .words .name',
    '.words .name'
  ], 'href');

  // 网易云播放栏时间格式：<span class="j-flag time"><em>01:46</em> / 05:02</span>
  // 只有一个 <em>，直接读整个 span 文字然后提取两段时间
  let elapsedText = '';
  let durationText = '';
  const timeSpanText = await readFirstAvailableText(contexts, [
    '.m-pbar .j-flag.time',
    '.m-playbar .j-flag.time',
    '.j-flag.time',
    '.m-pbar .time',
    '.m-playbar .time'
  ]);

  if (timeSpanText) {
    // 从 "01:46 / 05:02" 或 "01:46:05 / 01:30:00" 提取所有时间段
    const timeMatches = timeSpanText.match(/\d{1,2}:\d{2}(?::\d{2})?/g) || [];
    if (timeMatches.length >= 1) elapsedText = timeMatches[0];
    if (timeMatches.length >= 2) durationText = timeMatches[timeMatches.length - 1];
  }

  // 兜底：单独读 em 标签
  if (!elapsedText) {
    elapsedText = await readFirstAvailableText(contexts, [
      '.m-pbar .time em',
      '.m-playbar .time em'
    ]);
  }

  let elapsedMs = parseDurationText(elapsedText);
  let durationMs = parseDurationText(durationText);
  const songIdMatch = String(songHref || '').match(/id=(\d+)/);

  // 如果 span 全文读取失败，尝试从进度条百分比 + 歌单行读取时长
  if (songIdMatch && (!Number.isFinite(durationMs) || durationMs <= 0)) {
    const playlistSong = await readPlaylistSongMetadata(page, songIdMatch[1]);
    if (Number.isFinite(playlistSong.durationMs) && playlistSong.durationMs > 0) {
      durationMs = playlistSong.durationMs;
    }
  }

  // elapsed 仍不可用：用进度百分比 * durationMs 推算
  if ((!Number.isFinite(elapsedMs) || elapsedMs < 0) && Number.isFinite(durationMs) && durationMs > 0) {
    const progressPercent = await readProgressPercent(contexts, [
      '.m-pbar .barbg .cur',
      '.m-playbar .barbg .cur',
      '.m-playbar .cur',
      '.m-pbar .cur'
    ]);
    if (Number.isFinite(progressPercent) && progressPercent >= 0) {
      elapsedMs = Math.round(durationMs * (progressPercent / 100));
    }
  }

  if (Number.isFinite(durationMs) && durationMs <= 0) {
    durationMs = null;
  }
  if (Number.isFinite(elapsedMs) && elapsedMs < 0) {
    elapsedMs = null;
  }

  const remainingMs = Number.isFinite(durationMs) && durationMs > 0 && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? Math.max(0, durationMs - elapsedMs)
    : null;

  if (!title && !artist && !durationText && !elapsedText) {
    return null;
  }

  // 检测播放/暂停状态：data-action="pause" 表示正在播放，data-action="play" 表示已暂停
  let isPlaying = null;
  for (const ctx of contexts) {
    try {
      const playBtnAction = await ctx.locator('a.ply.j-flag[data-action]').first().getAttribute('data-action', { timeout: 1200 });
      if (playBtnAction === 'pause') { isPlaying = true; break; }
      if (playBtnAction === 'play') { isPlaying = false; break; }
    } catch { /* ignore */ }
  }

  return {
    title,
    artist,
    songId: songIdMatch ? songIdMatch[1] : '',
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    elapsedText: Number.isFinite(elapsedMs) ? formatDurationMs(elapsedMs) : '',
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    durationText: Number.isFinite(durationMs) ? formatDurationMs(durationMs) : '',
    remainingMs,
    remainingText: Number.isFinite(remainingMs) ? formatDurationMs(remainingMs) : '',
    isPlaying,
    capturedAt: new Date().toISOString()
  };
}

async function getStatus(rootDir, config, playlistUrl) {
  const loginState = await getLoginState();
  const running = await isContextAlive();
  const playerSnapshot = running ? await getPlaybackSnapshot() : null;
  return {
    available: true,
    enabled: Boolean(config.enabled),
    running,
    loggedIn: loginState.loggedIn,
    cookieNames: loginState.cookieNames,
    browserChannel: config.browserChannel || '(bundled chromium)',
    headless: Boolean(config.headless),
    userDataDir: config.userDataDir,
    resolvedUserDataDir: resolveUserDataDir(rootDir, config),
    currentUrl: playwrightRuntime.page && !playwrightRuntime.page.isClosed() ? playwrightRuntime.page.url() : '',
    targetPlaylistUrl: playlistUrl || '',
    targetPlaylistName: config.targetPlaylistName || playwrightRuntime.playlistName || '',
    playerSnapshot,
    launchedAt: playwrightRuntime.launchedAt,
    needsLogin: Boolean(playwrightRuntime.context) && !loginState.loggedIn
  };
}

async function clickFirstVisible(context, selectors) {
  for (const selector of selectors) {
    const locator = context.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 1500 });
      await locator.click();
      return selector;
    } catch {
    }
  }

  return null;
}

async function clickPlaylistOption(contexts, options = {}) {
  const playlistId = String(options.playlistId || '').trim();
  const playlistName = String(options.playlistName || '').trim();
  const searchContexts = Array.isArray(contexts) ? contexts.filter(Boolean) : [contexts].filter(Boolean);

  if (playlistId) {
    const idSelectors = [
      `.m-layer li[data-id="${playlistId}"]`,
      `.m-favgd li[data-id="${playlistId}"]`,
      `.zcnt li[data-id="${playlistId}"]`,
      `.u-arrlay li[data-id="${playlistId}"]`,
      `li[data-id="${playlistId}"]`
    ];

    for (const context of searchContexts) {
      for (const selector of idSelectors) {
        try {
          const locator = context.locator(selector).first();
          await locator.waitFor({ state: 'visible', timeout: 2500 });
          await locator.click();
          return true;
        } catch {
        }

        try {
          const itemLocator = context.locator(`${selector} .item`).first();
          await itemLocator.waitFor({ state: 'visible', timeout: 1200 });
          await itemLocator.click();
          return true;
        } catch {
        }
      }
    }
  }

  if (!playlistName) {
    return false;
  }

  const selectors = [
    `.m-layer .listhdc .title:has-text("${playlistName}")`,
    `.m-layer .txt:has-text("${playlistName}")`,
    `.m-layer li:has-text("${playlistName}")`,
    `.u-arrlay li:has-text("${playlistName}")`,
    `li:has-text("${playlistName}")`
  ];

  for (const context of searchContexts) {
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 2500 });
        await locator.click();
        return true;
      } catch {
      }
    }
  }

  return false;
}

function parseDurationText(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return ((hours * 60 * 60) + (minutes * 60) + seconds) * 1000;
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function readFirstAvailableText(contexts, selectors) {
  for (const context of contexts) {
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        const text = await locator.textContent({ timeout: 1200 });
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (normalized) {
          return normalized;
        }
      } catch {
      }
    }
  }

  return '';
}

async function readSongMetadata(page, frame, fallback = {}) {
  const contexts = [frame, page].filter(Boolean);
  const title = await readFirstAvailableText(contexts, [
    '.tit em.f-ff2',
    '.tit em',
    '.m-info .tit em',
    'em.f-ff2'
  ]);
  const artist = await readFirstAvailableText(contexts, [
    '.des.s-fc4 a',
    '.m-info .des a',
    'p.des a',
    '.cnt .des a'
  ]);
  const rawDuration = await readFirstAvailableText(contexts, [
    'span.u-dur',
    '.time .u-dur',
    '.m-info .time',
    '.time'
  ]);
  const durationMs = parseDurationText(rawDuration);

  return {
    title: title || fallback.title || '',
    artist: artist || fallback.artist || '',
    durationMs: durationMs || null,
    durationText: durationMs ? formatDurationMs(durationMs) : ''
  };
}

async function readPlaylistSongMetadata(page, songId, fallback = {}) {
  if (!songId) {
    return {
      title: fallback.title || '',
      artist: fallback.artist || '',
      durationMs: fallback.durationMs || null,
      durationText: fallback.durationText || ''
    };
  }

  const frame = await getMusicFrame(page);
  const contexts = [frame, page].filter(Boolean);
  const rowSelectors = [
    `tr:has([data-res-id="${songId}"])`,
    `tr[id^="${songId}"]`
  ];

  for (const context of contexts) {
    for (const rowSelector of rowSelectors) {
      try {
        const row = context.locator(rowSelector).first();
        await row.waitFor({ state: 'visible', timeout: 2500 });
        const title = (await row.locator('.txt a b').first().getAttribute('title').catch(() => '')) || fallback.title || '';
        const artist = (
          await row.locator('td:nth-child(4) .text [title]').first().getAttribute('title').catch(() => '')
        ) || (
          await row.locator('td:nth-child(4) .text a, td:nth-child(4) .text span').first().textContent().catch(() => '')
        ) || fallback.artist || '';
        const rawDuration = await row.locator('span.u-dur').first().textContent().catch(() => '');
        const durationMs = parseDurationText(rawDuration);
        return {
          title: String(title || '').trim(),
          artist: String(artist || '').replace(/\s+/g, ' ').trim(),
          durationMs: durationMs || fallback.durationMs || null,
          durationText: durationMs ? formatDurationMs(durationMs) : (fallback.durationText || '')
        };
      } catch {
      }
    }
  }

  return {
    title: fallback.title || '',
    artist: fallback.artist || '',
    durationMs: fallback.durationMs || null,
    durationText: fallback.durationText || ''
  };
}

async function addSongToPlaylist(rootDir, config, options) {
  if (!options.songUrl) {
    throw new Error('缺少可打开的网易云歌曲链接');
  }

  const page = await ensurePage(rootDir, config, options.songUrl);
  await page.bringToFront();
  await page.waitForTimeout(1500);

  const loginState = await getLoginState();
  if (!loginState.loggedIn) {
    throw new Error('受控浏览器尚未登录网易云');
  }

  let playlistName = config.targetPlaylistName || playwrightRuntime.playlistName || options.playlistName || '';
  if (!playlistName && options.playlistUrl) {
    const opened = await openTargetPlaylist(rootDir, config, options.playlistUrl);
    playlistName = opened.playlistName;
    await page.goto(options.songUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
  }

  if (!playlistName) {
    throw new Error('还没有识别出共享歌单名称，请先在 Playwright 浏览器里打开一次目标歌单');
  }

  const frame = await getMusicFrame(page);
  const song = await readSongMetadata(page, frame, {
    title: options.title,
    artist: options.artist
  });
  const actionContext = frame || page;
  const trigger = await clickFirstVisible(actionContext, [
    'a[data-action="collect"]',
    '.u-btn2.u-btn2-2:has-text("收藏")',
    '.btns .btn:has-text("收藏")',
    'a.u-btni-fav',
    '.oper .collect',
    '.m-info .collect',
    'button:has-text("收藏")',
    'a:has-text("收藏")',
    'button:has-text("添加")',
    'a:has-text("添加")'
  ]);

  if (!trigger) {
    throw new Error('没有在歌曲页面上找到“收藏/添加”入口，网页版结构可能已变化');
  }

  await page.waitForTimeout(1000);
  const matched = await clickPlaylistOption([frame, page], {
    playlistId: options.playlistId,
    playlistName
  });
  if (!matched) {
    throw new Error(`没有在弹层里找到目标歌单：${playlistName || options.playlistId || 'unknown'}`);
  }

  await page.waitForTimeout(1000);
  playwrightRuntime.playlistName = playlistName;

  if (options.playlistUrl && !song.durationMs) {
    await openTargetPlaylist(rootDir, config, options.playlistUrl);
    const playlistSong = await readPlaylistSongMetadata(playwrightRuntime.page, options.songId, song);
    song.title = playlistSong.title || song.title;
    song.artist = playlistSong.artist || song.artist;
    song.durationMs = playlistSong.durationMs || song.durationMs;
    song.durationText = playlistSong.durationText || song.durationText;
  }

  let playbackTriggered = false;
  if (config.autoPlayAfterSync && options.playlistUrl && options.shouldTriggerPlayback !== false) {
    // 精准播放刚加入的那首，而非从歌单开头重放
    await playSpecificSongInPlaylist(rootDir, config, options.playlistUrl, options.songId);
    playbackTriggered = true;
  } else if (options.playlistUrl && options.songId && options.shouldTriggerPlayback === false) {
    // 已有歌曲在播放中：把这首歌加入网易云播放列表（下一首队列），实现自动衔接
    await addSongToNetPlayQueue(rootDir, config, options.playlistUrl, options.songId);
  }

  return {
    playlistName,
    pageUrl: page.url(),
    song,
    playbackTriggered
  };
}

async function addSongToNetPlayQueue(rootDir, config, playlistUrl, songId) {
  if (!songId) return false;
  try {
    const opened = await openTargetPlaylist(rootDir, config, playlistUrl);
    const page = playwrightRuntime.page;
    const frame = await getMusicFrame(page).catch(() => null);
    const contexts = [frame, page].filter(Boolean);

    // 等歌曲列表渲染
    for (const ctx of contexts) {
      try {
        await ctx.locator('table.m-table tbody tr, tr[id]').first().waitFor({ state: 'visible', timeout: 8000 });
        break;
      } catch {}
    }
    await page.waitForTimeout(600);

    for (const ctx of contexts) {
      try {
        const row = ctx.locator(`tr:has(span[data-res-id="${songId}"])`).first();
        await row.waitFor({ state: 'attached', timeout: 4000 });
        await row.hover();
        await page.waitForTimeout(350);
        const addtoBtn = ctx.locator(`a.icn-add[data-res-action="addto"][data-res-id="${songId}"]`).first();
        await addtoBtn.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(600);
        console.log(`[addSongToNetPlayQueue] 已将 ${songId} 加入网易云播放列表`);
        return true;
      } catch (err) {
        console.warn(`[addSongToNetPlayQueue] ctx 尝试失败: ${err.message}`);
      }
    }
    console.warn(`[addSongToNetPlayQueue] 未找到 ${songId} 的 addto 按钮`);
    return false;
  } catch (err) {
    console.error(`[addSongToNetPlayQueue] 异常: ${err.message}`);
    return false;
  }
}

module.exports = {
  createPlaywrightConfig,
  resolveUserDataDir,
  ensurePage,
  openTargetPlaylist,
  playTargetPlaylist,
  playSpecificSongInPlaylist,
  getStatus,
  getPlaybackSnapshot,
  addSongToPlaylist,
  closeBrowser
};