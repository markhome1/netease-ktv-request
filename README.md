# music-scanplayer

局域网 KTV 扫码点歌系统。主机运行 Node.js 服务，生成二维码；手机扫码打开点歌页，粘贴网易云歌曲链接提交；服务端通过 Playwright 自动将歌曲写入网易云共享歌单并依次播放。

---

## 效果概览

```
手机扫码 → 粘贴网易云链接 → 立即点播 or 加入等待队列
                                       ↓
                         Playwright 控制网页版网易云
                         · 若空闲：加歌单 + 立即播放
                         · 若播放中：加歌单 + 加入播放列表（自动衔接）
                                       ↓
                         管理后台实时显示：当前歌曲 / 队列 / 预计等待时间
```

---

## 目录结构

```
music-scanplayer/
├── server.js                  # 主服务入口：Express + Socket.IO + 队列逻辑
├── lib/
│   ├── netease-playwright.js  # Playwright 自动化核心（最常改动）
│   ├── netease.js             # 解析网易云链接 → 歌曲 ID
│   ├── netease-api.js         # 第三方兼容 API（备用，当前主要靠 Playwright）
│   ├── netease-openapi.js     # 网易云官方 OpenAPI（暂未启用）
│   ├── netease-openapi-endpoints.js  # 官方 API 端点列表
│   └── external-player.js    # 外部播放器命令启动（备用扩展）
├── public/
│   ├── request.html / request.js    # 手机点歌页
│   ├── admin.html / admin.js        # 管理后台
│   └── styles.css                   # 全局样式
├── data/                      # 运行时数据（.gitignore 已忽略）
│   ├── state.json             # 持久化队列 / 配置 / 播放快照
│   └── playwright-profile/    # Playwright 浏览器用户数据（保存登录态）
├── docs/
│   ├── netease-openapi-plan.md       # 官方 API 调研记录
│   └── netease-openapi-endpoints.md  # 官方 API 端点文档
└── package.json
```

---

## 架构说明

### 核心数据流

```
POST /api/requests
      │
      ▼
validateSongPayload()         ← 验证网易云链接格式
      │
      ▼
resolveNeteaseInput()         ← 解析为 { type: 'song', id: '123456' }
      │
      ▼
tryAutoSyncQueueEntry()       ← 判断：立即播放 还是 进队列等待
      │
      ├─ 无歌曲在播 → addSongToPlaylistWithPlaywright({ shouldTriggerPlayback: true })
      │                    └→ playSpecificSongInPlaylist()  精准播放刚加的这首
      │
      └─ 有歌曲在播 → addSongToPlaylistWithPlaywright({ shouldTriggerPlayback: false })
                           └→ addSongToNetPlayQueue()  添加到网易云内部播放列表
```

### 服务器状态（state.json）

| 字段 | 说明 |
|------|------|
| `nowPlaying` | 当前播放的歌曲对象 |
| `queue` | 等待播放的歌曲数组（有序） |
| `history` | 已播完的历史记录 |
| `pendingRequests` | 待审批请求（当前默认自动审批） |
| `netease.playbackSnapshot` | 上一次从 Playwright 读到的播放器状态（含 `isPlaying`、`elapsedMs`、`remainingMs`） |
| `netease.playwright` | Playwright 配置（歌单名、浏览器通道、用户目录等） |

### 自动推进机制（autoAdvancePoll）

服务启动后每 6 秒轮询一次 Playwright 播放器状态：
- 网易云切到下一首 → 服务器队列同步推进（`moveQueueToNowPlaying`）
- 时间兜底：若 `nowPlaying` 的 `elapsedMs > durationMs + 8s` 且队列不为空 → 强制推进

### 暂停检测

`getPlaybackSnapshot()` 读取播放栏按钮的 `data-action` 属性：
- `data-action="pause"` → `isPlaying: true`（正在播放）
- `data-action="play"` → `isPlaying: false`（已暂停）

当检测到暂停时，`buildWaitEstimateForItem()` 将整个预计等待时间归零，下一位点歌者看到 `00:00`。

### Socket.IO 实时推送

所有状态变更（新请求、开始播放、切歌、队列更新）均通过 `socket.emit('state:update', buildPublicState())` 广播到所有已连接客户端，前端无需轮询。

---

## 快速上手

### 环境要求

- Node.js 18+
- Windows / macOS / Linux（Playwright 均支持）

### 安装

```bash
git clone https://github.com/markhome1/music-scanplayer.git
cd music-scanplayer
npm install
npx playwright install chromium   # 首次安装 Playwright 浏览器
```

### 启动

```bash
npm start
```

启动后访问：
- 管理后台：`http://<主机IP>:8080/admin`
- 手机点歌页：`http://<主机IP>:8080/request`

### 首次配置（管理后台）

1. 在 **PLAYWRIGHT SETUP** 区域填写目标歌单名称（网易云里已创建好的歌单）
2. 勾选"启用自动写共享歌单"和"加歌后自动点击歌单播放"
3. 点击"**启动浏览器**"，在弹出的 Chromium 窗口里手动登录网易云账号（一次性）
4. 点击"**打开共享歌单**"，确认页面跳到目标歌单
5. 手机扫码（或直接访问 `/request`），粘贴网易云歌曲链接，点击"立即接龙"

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

### 查询状态

```
GET /api/state
```

返回完整的服务器状态，包括 `nowPlaying`、`queue`、`queueTiming`（等待时间计算结果）。

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
| `GET`  | `/api/netease/playwright-status` | 获取 Playwright 当前状态 |

---

## 开发指南

### 本地开发

```bash
npm run dev   # 等同于 npm start，暂无热重载
```

### 关键模块说明

#### `lib/netease-playwright.js`

所有与网易云网页版交互的逻辑都在这里，**改动最频繁**。主要函数：

| 函数 | 作用 |
|------|------|
| `launchBrowser()` | 启动 Playwright Chromium，加载持久化用户数据 |
| `getPlaybackSnapshot()` | 读取当前播放栏状态（歌名、进度、`isPlaying`） |
| `openTargetPlaylist()` | 导航到目标歌单页 |
| `addSongToPlaylist()` | 将歌曲收藏到共享歌单（主入口，含播放分支判断） |
| `playSpecificSongInPlaylist()` | 在歌单里精准点击某首歌的播放按钮 |
| `addSongToNetPlayQueue()` | 将歌曲加入网易云内部"播放列表"（队列衔接的关键） |
| `ensurePlaybackStarted()` | 若播放器处于暂停状态则主动点击播放 |

> **注意**：网易云网页版改版后 CSS 选择器可能失效，需更新 `readFirstAvailableAttr` / `readFirstAvailableText` 里对应的选择器列表。

#### `server.js`

路由、状态管理、队列推进逻辑。关键函数：

| 函数 | 作用 |
|------|------|
| `buildWaitEstimateForItem()` | 计算某首歌的预计等待时间 |
| `buildQueueTimingSummary()` | 构建供前端展示的等待时间摘要 |
| `tryAutoSyncQueueEntry()` | 决定新歌是立即播放还是加队列 |
| `autoAdvancePoll()` | 定时同步网易云播放器状态到服务器队列 |
| `moveQueueToNowPlaying()` | 将队列第一首推进为 nowPlaying |

### PR 规范

提交 PR 时请在描述里说明以下几点：

1. **改了什么**：例如"修复 `addSongToNetPlayQueue` 在歌单超过 50 首时找不到歌曲行的问题"
2. **为什么改**：复现步骤或触发条件
3. **怎么测试**：建议附上测试三首歌（空闲状态 + 2 首排队）的完整流程截图或日志
4. **选择器变更**：如果修改了 Playwright CSS 选择器，请说明新旧选择器及网易云改版原因

### 已知局限

- Playwright 方案依赖网易云网页版 DOM 结构，网易云改版后可能需要更新选择器
- `getPlaybackSnapshot()` 需要浏览器窗口保持前台或不被遮挡（部分系统下后台进程读不到 DOM）
- 官方 OpenAPI（`lib/netease-openapi.js`）已有框架但暂未接入主流程，欢迎贡献

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
