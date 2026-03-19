# netease-ktv-request

**网易云 KTV 扫码点歌系统** · QR-based song request queue for NetEase Music

局域网 KTV 点歌工具。主机运行 Node.js 服务，生成二维码；手机扫码打开点歌页，搜索歌曲或粘贴链接提交；服务端通过 Playwright 自动将歌曲写入网易云播放列表并依次播放，实时显示等待队列和预计等待时间。

---

## 效果概览

```
手机扫码 → 搜索歌曲 / 粘贴网易云链接 → 立即点播 or 加入等待队列
                                              ↓
                            Playwright 控制网页版网易云
                            · 若空闲：清空旧列表 + 加歌 + 立即播放
                            · 若播放中：加歌到播放列表（自动衔接）
                                              ↓
                            点歌页实时显示：
                            · NOW PLAYING（当前歌曲 + 剩余时间）
                            · WAITING QUEUE（等待队列 + 每首等待时间）
                            · PLAYER PLAYLIST（完整播放列表 + 点击播放）
                            · 暂停 / 继续 / 切歌 / 音量控制
```

---

## 功能特性

| 功能 | 说明 |
|------|------|
| 🔍 搜索点歌 | 输入歌名或歌手搜索，点击即可点歌 |
| 🔗 链接点歌 | 粘贴网易云歌曲链接提交 |
| 📋 播放列表 | 实时展示网易云播放器的完整列表，可点击任意歌曲播放 |
| ⏳ 等待队列 | 自动从播放列表派生，显示每首歌的预计等待时间 |
| 🚫 自动查重 | 已在播放列表等待区的歌曲不允许重复点歌 |
| ⏯ 播放控制 | 暂停 / 继续 / 切歌 / 音量调节 |
| 📱 实时刷新 | Socket.IO 推送 + 客户端 1 秒插值，等待时间实时倒计时 |
| 🖥 后台运行 | 浏览器自动隐藏到屏幕外，不干扰主机正常使用 |
| 🚀 一键启动 | 提供 `start.bat` / `start-silent.vbs` / `stop.bat` 脚本 |

---

## 目录结构

```
music-scanplayer/
├── server.js                  # 主服务入口：Express + Socket.IO + 队列逻辑
├── lib/
│   ├── netease-playwright.js  # Playwright 自动化核心（最常改动）
│   ├── netease.js             # 解析网易云链接 → 歌曲 ID
│   ├── netease-api.js         # 第三方兼容 API（备用）
│   ├── netease-openapi.js     # 网易云官方 OpenAPI（暂未启用）
│   ├── netease-openapi-endpoints.js
│   └── external-player.js     # 外部播放器（备用扩展）
├── public/
│   ├── request.html / request.js    # 手机点歌页（搜索、队列、控制）
│   ├── admin.html / admin.js        # 管理后台
│   └── styles.css                   # 全局样式
├── data/                      # 运行时数据（.gitignore 已忽略）
│   ├── state.json             # 持久化队列 / 配置 / 播放快照
│   └── playwright-profile/    # Playwright 浏览器用户数据（保存登录态）
├── start.bat                  # 双击启动（显示控制台）
├── start-silent.vbs           # 静默后台启动 + 自动打开管理页
├── stop.bat                   # 停止服务
└── package.json
```

---

## 架构说明

### 核心数据流

```
POST /api/requests  ──或──  POST /api/search
      │                           │
      ▼                           ▼
validateSongPayload()      searchSongsWithPlaywright()
      │                           │
      ▼                           ▼
resolveNeteaseInput()      返回搜索结果 → 用户选择 → POST /api/requests
      │
      ▼
查重检查：该歌曲是否已在播放列表等待区？
      │
      ├── 已存在 → 返回 400 "无需重复点歌"
      │
      └── 不存在 → tryAutoSyncQueueEntry()
                         │
                         ├── 无歌曲在播 → clearNetPlayQueue() + addSongToPlaylist(triggerPlayback)
                         │
                         └── 有歌曲在播 → addSongToPlaylist(队列衔接)
                                              │
                                              ▼
                                    refreshCachedPlaylist() → broadcastState()
```

### 播放列表驱动的等待队列

系统定期（~20秒）从 Playwright 浏览器读取网易云播放列表缓存到服务端。等待队列直接从播放列表派生：

```
播放列表：[听海] [一荤一素] [月半小夜曲✦] [我是真的爱上你] [遥远的她]
                              ↑当前播放
                                              ↓
等待队列：  我是真的爱上你 (04:48)  →  遥远的她 (09:50)
            ↑ 当前歌曲剩余时间         ↑ 累计等待时间
```

优势：
- **去重天然可靠**：基于实际播放列表检查
- **等待时间准确**：使用播放列表中的实际歌曲时长
- **切歌自动同步**：检测到切歌时立即刷新播放列表

### 服务器状态（state.json）

| 字段 | 说明 |
|------|------|
| `nowPlaying` | 当前播放的歌曲对象 |
| `queue` | 服务端内部队列（用于同步追踪） |
| `history` | 已播完的历史记录 |
| `netease.playbackSnapshot` | 从 Playwright 读取的播放器状态（`isPlaying`、`elapsedMs`、`remainingMs`） |
| `netease.playwright` | Playwright 配置（歌单名、浏览器通道、autoMinimize 等） |

### 自动推进机制（autoAdvancePoll）

服务启动后每 5 秒轮询一次 Playwright 播放器状态：
- 首次轮询自动启动 Playwright 浏览器（如已启用）
- 每 4 个周期（~20秒）刷新播放列表缓存
- 网易云切到下一首 → 立即刷新播放列表 + 同步推进队列
- 时间兜底：若 `elapsedMs > durationMs + 8s` 且队列不为空 → 强制推进
- 每次轮询都通过 Socket.IO 广播最新状态

### 浏览器隐藏策略

使用 CDP 将浏览器窗口移到屏幕外坐标 `(-32000, -32000)` 而非真正的最小化。原因：Chromium 在 `windowState: 'minimized'` 状态下会暂停渲染引擎，导致所有 DOM 操作失败。屏幕外定位保持渲染引擎正常工作，同时对用户完全不可见。

### Socket.IO 实时推送

所有状态变更通过 `socket.emit('state:update', buildPublicState())` 广播，前端无需轮询。客户端使用 1 秒间隔的 `setInterval` 对服务端预计算的等待时间做插值倒计时。

---

## 快速上手

### 环境要求

- Node.js 18+
- Windows / macOS / Linux（Playwright 均支持）

### 安装

```bash
git clone https://github.com/markhome1/netease-ktv-request.git
cd netease-ktv-request
npm install
npx playwright install chromium   # 首次安装 Playwright 浏览器
```

### 启动

```bash
npm start
```

或在 Windows 上双击 `start.bat`（显示控制台）/ `start-silent.vbs`（静默后台启动）。

启动后访问：
- 管理后台：`http://<主机IP>:8080/admin`
- 手机点歌页：`http://<主机IP>:8080/request`

### 首次配置（管理后台）

1. 在 **PLAYWRIGHT SETUP** 区域填写目标歌单名称
2. 勾选"启用自动写共享歌单"和"加歌后自动点击歌单播放"
3. 勾选"自动隐藏浏览器"使 Chromium 窗口不干扰主机使用
4. 点击"**启动浏览器**"，在弹出的 Chromium 窗口里手动登录网易云账号（一次性）
5. 点击"**打开共享歌单**"，确认页面跳到目标歌单
6. 手机扫码访问 `/request`，搜索歌曲或粘贴链接，开始点歌

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 服务监听端口 |

---

## API 参考

### 点歌

```
POST /api/requests
Content-Type: application/json

{ "neteaseUrl": "https://music.163.com/song?id=28310544" }
```

响应包含 `waitEstimate`（预计等待时间）和 `syncStatus`（同步结果）。  
如果歌曲已在播放列表等待区，返回 `400 { error: "这首歌已在播放列表中，无需重复点歌" }`。

### 搜索歌曲

```
POST /api/search
Content-Type: application/json

{ "keyword": "周杰伦 晴天" }
```

返回搜索结果数组，每项包含 `id`、`name`、`artist`、`duration`。

### 播放列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/playlist` | 获取网易云播放器当前播放列表 |
| `POST` | `/api/playlist/play/:songId` | 播放列表中的指定歌曲 |
| `POST` | `/api/playlist/clear` | 清空播放列表 |

### 播放控制

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/player/pause` | 暂停播放 |
| `POST` | `/api/player/resume` | 继续播放 |
| `POST` | `/api/player/skip` | 切歌（下一首） |
| `GET` | `/api/player/volume` | 获取当前音量 |
| `POST` | `/api/player/volume` | 设置音量 `{ "volume": 0-100 }` |

### 查询状态

```
GET /api/state
```

返回完整服务器状态，包括 `nowPlaying`、`queue`、`playerPlaylist`（播放列表派生的等待队列）、`queueTiming`。

### 管理操作

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/player/clear` | 结束本次歌单，清空所有队列和播放状态 |
| `POST` | `/api/queue/:id/remove` | 从队列移除指定歌曲 |
| `POST` | `/api/config/netease-playwright` | 更新 Playwright 配置 |
| `POST` | `/api/netease/playwright/launch` | 启动 Playwright 浏览器 |
| `POST` | `/api/netease/playwright/close` | 关闭 Playwright 浏览器 |
| `POST` | `/api/netease/playwright/open-playlist` | 跳转到目标歌单页面 |
| `POST` | `/api/netease/playwright/play-playlist` | 点击歌单播放按钮 |
| `GET` | `/api/netease/playwright-status` | 获取 Playwright 当前状态 |

---

## 开发指南

### 本地开发

```bash
npm run dev   # 等同于 npm start，暂无热重载
```

### 关键模块说明

#### `lib/netease-playwright.js`

所有与网易云网页版交互的逻辑，**改动最频繁**。主要函数：

| 函数 | 作用 |
|------|------|
| `ensurePage()` | 启动 Playwright Chromium，加载持久化用户数据 |
| `getPlaybackSnapshot()` | 读取当前播放栏状态（歌名、进度、`isPlaying`） |
| `addSongToPlaylist()` | 将歌曲收藏到共享歌单（含播放分支判断） |
| `searchSongs()` | 在网易云搜索页搜索歌曲，返回结果列表 |
| `getPlaylist()` | 读取网易云播放器当前播放列表 |
| `playFromPlaylist()` | 在播放列表中双击播放指定歌曲 |
| `clearNetPlayQueue()` | 清空网易云播放列表 |
| `pausePlayback()` / `resumePlayback()` / `skipToNext()` | 播放控制 |
| `getVolume()` / `setVolume()` | 音量控制 |
| `minimizeBrowserWindow()` | 将浏览器移到屏幕外（保持渲染引擎活跃） |

> **注意**：网易云网页版改版后 CSS 选择器可能失效，需更新选择器列表。

#### `server.js`

路由、状态管理、队列推进逻辑。关键函数：

| 函数 | 作用 |
|------|------|
| `buildPlaylistWaitQueue()` | 从缓存的播放列表派生等待队列和等待时间 |
| `refreshCachedPlaylist()` | 从 Playwright 浏览器刷新播放列表缓存 |
| `buildQueueTimingSummary()` | 构建供前端展示的等待时间摘要 |
| `tryAutoSyncQueueEntry()` | 决定新歌是立即播放还是加队列 |
| `autoAdvancePoll()` | 定时同步播放器状态 + 刷新播放列表 |
| `refreshPlaybackSnapshot()` | 读取播放器快照 + 自动修正歌曲时长 |

### 已知局限

- Playwright 方案依赖网易云网页版 DOM 结构，网易云改版后可能需要更新选择器
- 官方 OpenAPI（`lib/netease-openapi.js`）已有框架但暂未接入主流程，欢迎贡献
- 搜索功能通过 Playwright 操作搜索页实现，非 API 直连，速度受网络影响

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端框架 | [Express 4](https://expressjs.com/) |
| 实时通信 | [Socket.IO 4](https://socket.io/) |
| 浏览器自动化 | [Playwright 1.x](https://playwright.dev/) |
| 二维码生成 | [qrcode](https://github.com/soldair/node-qrcode) |
| 前端 | 原生 HTML / CSS / JS（无框架） |
| 持久化 | 本地 JSON 文件（`data/state.json`） |

---

## License

MIT
