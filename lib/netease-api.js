function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回了非 JSON 内容: ${text.slice(0, 120)}`);
  }

  if (!response.ok) {
    throw new Error(data.message || data.msg || `接口请求失败: ${response.status}`);
  }

  return data;
}

async function fetchSongUrl(config, songId) {
  const baseUrl = normalizeBaseUrl(config.apiBaseUrl);
  if (!baseUrl) {
    throw new Error('未配置网易云 API 地址');
  }

  const headers = {};
  if (config.cookie) {
    headers.cookie = config.cookie;
  }

  const level = config.qualityLevel || 'standard';
  const firstUrl = `${baseUrl}/song/url/v1?id=${encodeURIComponent(songId)}&level=${encodeURIComponent(level)}`;
  const firstData = await requestJson(firstUrl, { headers });
  const firstEntry = Array.isArray(firstData.data) ? firstData.data[0] : null;
  if (firstEntry && firstEntry.url) {
    return {
      url: firstEntry.url,
      source: 'song/url/v1',
      raw: firstData
    };
  }

  const fallbackUrl = `${baseUrl}/song/url?id=${encodeURIComponent(songId)}&br=320000`;
  const fallbackData = await requestJson(fallbackUrl, { headers });
  const fallbackEntry = Array.isArray(fallbackData.data) ? fallbackData.data[0] : null;
  if (fallbackEntry && fallbackEntry.url) {
    return {
      url: fallbackEntry.url,
      source: 'song/url',
      raw: fallbackData
    };
  }

  throw new Error('没有拿到可播放链接');
}

async function addTrackToPlaylist(config, playlistId, songId) {
  const baseUrl = normalizeBaseUrl(config.apiBaseUrl);
  if (!baseUrl) {
    throw new Error('未配置网易云 API 地址');
  }

  if (!config.cookie) {
    throw new Error('未配置网易云 Cookie，无法自动写入歌单');
  }

  const headers = {
    cookie: config.cookie
  };

  const url = `${baseUrl}/playlist/tracks?op=add&pid=${encodeURIComponent(playlistId)}&tracks=${encodeURIComponent(songId)}`;
  const data = await requestJson(url, {
    method: 'POST',
    headers
  });

  const code = Number(data.code || 0);
  if (code !== 200) {
    throw new Error(data.message || data.msg || `写入歌单失败: ${code}`);
  }

  return data;
}

module.exports = {
  normalizeBaseUrl,
  fetchSongUrl,
  addTrackToPlaylist
};
