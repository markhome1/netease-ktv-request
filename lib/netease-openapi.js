const { OFFICIAL_ENDPOINTS, QR_LOGIN_STATUS } = require('./netease-openapi-endpoints');

function createOfficialConfig(input = {}) {
  const defaultDeviceProfile = {
    deviceType: 'web',
    os: 'windows',
    appVer: '0.1.0',
    channel: 'music-scanplayer',
    deviceId: 'music-scanplayer-local',
    brand: 'custom',
    model: 'host',
    osVer: 'unknown'
  };
  const rawDeviceProfile = input.deviceProfileJson || input.deviceProfile;
  const normalizedRawDeviceProfile = typeof rawDeviceProfile === 'string'
    ? rawDeviceProfile.trim()
    : rawDeviceProfile;
  const deviceProfileJson = normalizedRawDeviceProfile
    ? (typeof normalizedRawDeviceProfile === 'string'
      ? normalizedRawDeviceProfile
      : JSON.stringify(normalizedRawDeviceProfile, null, 2))
    : JSON.stringify(defaultDeviceProfile, null, 2);

  return {
    provider: 'official-openapi',
    openapiBaseUrl: String(input.openapiBaseUrl || 'https://openapi.music.163.com').trim(),
    appId: String(input.appId || '').trim(),
    appSecret: String(input.appSecret || '').trim(),
    privateKey: String(input.privateKey || '').trim(),
    publicKeyFingerprint: String(input.publicKeyFingerprint || '').trim(),
    anonymousAccessToken: String(input.anonymousAccessToken || '').trim(),
    accessToken: String(input.accessToken || '').trim(),
    refreshToken: String(input.refreshToken || '').trim(),
    loginMode: String(input.loginMode || 'oauth').trim() || 'oauth',
    callbackUrl: String(input.callbackUrl || '').trim(),
    deviceProfileJson
  };
}

function validateOfficialConfig(config) {
  const errors = [];
  let deviceProfile = null;

  if (!config.appId) {
    errors.push('缺少 App ID');
  }
  if (!config.appSecret) {
    errors.push('缺少 App Secret');
  }
  if (!config.privateKey) {
    errors.push('缺少私钥');
  }

  try {
    deviceProfile = JSON.parse(String(config.deviceProfileJson || '{}'));
  } catch {
    errors.push('设备参数 JSON 格式无效');
  }

  const readiness = {
    signingReady: Boolean(config.appId && config.appSecret && config.privateKey),
    anonymousTokenBootstrapReady: Boolean(config.appId && config.appSecret && config.privateKey && deviceProfile),
    anonymousLoginReady: Boolean(config.appId && config.appSecret && config.privateKey && config.anonymousAccessToken && deviceProfile),
    userTokenReady: Boolean(config.accessToken),
    refreshReady: Boolean(config.appId && config.appSecret && config.privateKey && config.refreshToken),
    callbackReady: Boolean(config.callbackUrl),
    deviceReady: Boolean(deviceProfile && typeof deviceProfile === 'object' && !Array.isArray(deviceProfile))
  };

  return {
    ok: errors.length === 0,
    errors,
    readiness,
    parsedDeviceProfile: deviceProfile
  };
}

function explainOfficialMode(config = {}) {
  const confirmedEndpoints = [
    OFFICIAL_ENDPOINTS.complexSearch,
    OFFICIAL_ENDPOINTS.getSongPlayUrl,
    OFFICIAL_ENDPOINTS.getLoginQrCode,
    OFFICIAL_ENDPOINTS.anonymousLogin,
    OFFICIAL_ENDPOINTS.pollLoginQrCodeStatus,
    OFFICIAL_ENDPOINTS.refreshAccessToken,
    OFFICIAL_ENDPOINTS.exchangeGrantCodeForToken,
    OFFICIAL_ENDPOINTS.batchAddSongsToPlaylist,
    OFFICIAL_ENDPOINTS.getPlaylistDetail,
    OFFICIAL_ENDPOINTS.getPlaylistSongs,
    OFFICIAL_ENDPOINTS.getRecentPlayedPlaylists
  ].map((entry) => `${entry.name} ${entry.path}`);

  const validation = validateOfficialConfig(config);

  return {
    supportedToday: [
      '保存官方 OpenAPI 配置骨架',
      '作为后续 provider 切换目标',
      '保留现有扫码点歌和主机播放逻辑',
      '已经具备扫码登录、歌单写入、歌单读取和最近播放歌单读取的文档字段基础',
      '已经支持保存匿名 token、用户 token、refresh token 和设备公参模板',
      '已经补齐匿名登录与 refresh token 续期所需字段'
    ],
    confirmedEndpoints,
    qrLoginStatus: QR_LOGIN_STATUS,
    readiness: validation.readiness,
    tokenLifecycle: {
      anonymousToken: '匿名 accessToken 与 deviceId 强绑定，可长期缓存，用于游客模式与二维码轮询',
      accessToken: '用户 accessToken 默认 7 天有效，任意接口提示过期时先尝试 refresh',
      refreshToken: '用户 refreshToken 默认 20 天有效，超过后通常需要重新登录'
    },
    blockedToday: [
      '尚未接入官方签名和 RSA 请求加密',
      '尚未把匿名登录、二维码轮询、refresh token 续期真正接进服务端请求链路',
      '尚未把官方请求真正接进现有搜索、播放和歌单同步 provider'
    ]
  };
}

module.exports = {
  createOfficialConfig,
  validateOfficialConfig,
  explainOfficialMode
};
