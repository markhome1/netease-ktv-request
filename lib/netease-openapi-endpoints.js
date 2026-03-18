const OFFICIAL_ENDPOINTS = {
  complexSearch: {
    name: '综合搜索',
    path: '/openapi/music/basic/complex/search',
    method: 'GET_OR_POST',
    bizContent: ['keyword', 'qualityFlag', 'identityFlag', 'subCountFlag']
  },
  getSongPlayUrl: {
    name: '获取歌曲播放 URL',
    path: '/openapi/music/basic/song/playurl/get/v2',
    method: 'GET_OR_POST',
    bizContent: ['songId', 'bitrate', 'effects', 'level', 'immerseType']
  },
  getLoginQrCode: {
    name: '获取登录二维码',
    path: '/openapi/music/basic/user/oauth2/qrcodekey/get/v2',
    method: 'GET_OR_POST',
    bizContent: ['type', 'expiredKey']
  },
  anonymousLogin: {
    name: '匿名登录',
    path: '/openapi/music/basic/oauth2/login/anonymous',
    method: 'GET_OR_POST',
    bizContent: ['clientId']
  },
  pollLoginQrCodeStatus: {
    name: '轮询二维码状态',
    path: '/openapi/music/basic/oauth2/device/login/qrcode/get',
    method: 'GET_OR_POST',
    bizContent: ['key', 'clientId']
  },
  refreshAccessToken: {
    name: '通过 RefreshToken 刷新 AccessToken',
    path: '/openapi/music/basic/user/oauth2/token/refresh/v2',
    method: 'GET_OR_POST',
    bizContent: ['clientId', 'clientSecret', 'refreshToken']
  },
  exchangeGrantCodeForToken: {
    name: '回调 code 换取 accessToken',
    path: '/openapi/music/basic/user/oauth2/token/get/v2',
    method: 'GET_OR_POST',
    bizContent: ['grantCode']
  },
  batchAddSongsToPlaylist: {
    name: '批量添加歌曲到歌单',
    path: '/openapi/music/basic/playlist/song/batch/like',
    method: 'GET_OR_POST',
    bizContent: ['playlistId', 'songIdList']
  },
  getPlaylistDetail: {
    name: '获取歌单详情',
    path: '/openapi/music/basic/playlist/detail/get/v2',
    method: 'GET_OR_POST',
    bizContent: ['playlistId', 'originalCoverFlag', 'newCoverFlag']
  },
  getPlaylistSongs: {
    name: '获取歌单里的歌曲列表',
    path: '/openapi/music/basic/playlist/song/list/get/v3',
    method: 'GET_OR_POST',
    bizContent: ['playlistId', 'limit', 'offset', 'qualityFlag']
  },
  getRecentPlayedPlaylists: {
    name: '获取最近播放歌单列表',
    path: '/openapi/music/basic/playlist/play/record/list',
    method: 'GET_OR_POST',
    bizContent: ['limit']
  }
};

const QR_LOGIN_STATUS = {
  expired: 800,
  waiting: 801,
  authorizing: 802,
  success: 803,
  unknownError: 804
};

function buildOfficialUrl(baseUrl, endpointPath) {
  const normalized = String(baseUrl || 'https://openapi.music.163.com').replace(/\/+$/, '');
  return `${normalized}${endpointPath}`;
}

module.exports = {
  OFFICIAL_ENDPOINTS,
  QR_LOGIN_STATUS,
  buildOfficialUrl
};
