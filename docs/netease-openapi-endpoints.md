# 网易云官方接口映射

## 已确认可用于当前项目的接口

### 1. 综合搜索

- 名称：根据关键字综合搜索
- 路径：/openapi/music/basic/complex/search
- 方法：GET/POST
- bizContent 关键参数：
  - keyword: String, 必填
  - qualityFlag: Boolean, 可选
  - identityFlag: Boolean, 可选
  - subCountFlag: Boolean, 可选
- 对当前项目的价值：
  - 手机端搜索歌曲、歌单、专辑、艺人
  - 返回 song.id、song.name、artists、album、playFlag、vipFlag、coverImgUrl 等字段
- 关键返回：
  - data.songs[]
  - song.id
  - song.name
  - song.artists[]
  - song.playFlag
  - song.vipPlayFlag
  - song.visible

### 2. 获取歌曲播放 URL

- 名称：获取歌曲播放url
- 路径：/openapi/music/basic/song/playurl/get/v2
- 方法：GET/POST
- bizContent 关键参数：
  - songId: string, 必填
  - bitrate: Int, 可选，默认 320
  - effects: string, 可选
  - level: String, 可选
  - immerseType: String, 可选
- 对当前项目的价值：
  - 主机端拿官方播放地址后统一播放
- 关键返回：
  - data.url
  - data.br
  - data.level
  - data.freeTrail
  - subCode
- 关键业务含义：
  - subCode=200: 正常获取
  - subCode=10003: 因合作方要求，请前往手机端收听
  - subCode=10004: 该歌曲为付费歌曲，请前往手机端购买后收听
- 额外说明：
  - 文档说明播放地址是临时有效的
  - 会员身份会影响是否返回完整可播放链接

### 3. 获取登录二维码

- 名称：获取登录二维码
- 路径：/openapi/music/basic/user/oauth2/qrcodekey/get/v2
- 方法：GET/POST
- bizContent 关键参数：
  - type: int, 固定传 2
  - expiredKey: string, 固定建议 300
- 对当前项目的价值：
  - 管理台发起网易云官方登录二维码
  - 用户使用网易云 App 扫码完成登录
- 关键返回：
  - data.qrCodeUrl
  - data.uniKey
- 关键流程：
  - 获取二维码后，文档提示后续应每 2~3 秒轮询一次二维码状态

### 4. 轮询二维码状态

- 名称：轮询二维码状态
- 路径：/openapi/music/basic/oauth2/device/login/qrcode/get
- 方法：GET/POST
- bizContent 关键参数：
  - key: String, 必填，对应二维码 unikey
  - clientId: String, 必填，对应 appId
- 对当前项目的价值：
  - 管理台可以轮询扫码状态，直到拿到用户 accessToken
  - 已经足够支撑“二维码登录成功后把 token 存到官方模式配置”这一步
- 关键返回：
  - data.status
  - data.msg
  - data.accessToken.accessToken
  - data.accessToken.refreshToken
  - data.accessToken.expireTime
- 关键状态码：
  - 800: 二维码不存在或过期
  - 801: 等待扫码
  - 802: 授权中
  - 803: 授权登录成功
  - 804: 未知错误
- 额外说明：
  - 文档明确要求使用匿名 token 轮询
  - 二维码有效期 5 分钟，且只能扫一次
  - accessToken 默认 7 天过期，refreshToken 默认 20 天过期

### 5. 匿名登录

- 名称：匿名登录
- 路径：/openapi/music/basic/oauth2/login/anonymous
- 方法：GET/POST
- bizContent 关键参数：
  - clientId: String, 必填，对应 appId
- 对当前项目的价值：
  - 这是二维码轮询前的前置步骤
  - 可以为当前主机设备获取匿名 token，用于游客模式和二维码状态轮询
- 关键返回：
  - data.accessToken
  - data.refreshToken
  - data.expireTime
- 额外说明：
  - 文档强调匿名 token 与 deviceId 强绑定，应缓存在客户端或本地配置中
  - 文档说明匿名 token 可长期缓存，refreshToken 和 expireTime 基本不用管

### 6. 通过 RefreshToken 刷新 AccessToken

- 名称：通过 RefreshToken 来刷新 AccessToken
- 路径：/openapi/music/basic/user/oauth2/token/refresh/v2
- 方法：GET/POST
- bizContent 关键参数：
  - clientId: String, 必填，对应 appId
  - clientSecret: String, 必填，对应 appSecret
  - refreshToken: String, 必填，用户登录得到的 refreshToken
- 对当前项目的价值：
  - 用户 accessToken 过期时，服务端可以自动续期，不需要频繁重新扫码登录
  - 这一步要求项目保存 appSecret
- 关键返回：
  - data.accessToken
  - data.refreshToken
  - data.expiresTime
- 关键业务含义：
  - 7 天内优先使用 accessToken
  - 7 到 20 天内可用 refreshToken 续期
  - 超过 20 天通常要重新登录
- 常见异常：
  - 1406: accessToken 过期或者 refreshToken 过期
  - 1407: 账号不存在、被封禁或授权码失效
  - 1408: accessToken 无效
  - appId 混用会直接 parameter error
  - 匿名 token 不能拿来刷新用户 token

### 7. 回调 code 换取 accessToken

- 名称：回调 code 换取 accessToken
- 路径：/openapi/music/basic/user/oauth2/token/get/v2
- 方法：GET/POST
- bizContent 关键参数：
  - grantCode: String, 必填，回调拿到的临时 code
- 对当前项目的价值：
  - 如果后续补 H5/唤端登录，这个接口可以作为二维码登录之外的第二条官方登录链路
  - 服务端可安全完成 code 换 token
- 关键返回：
  - data.accessToken
  - data.refreshToken
  - data.expireIn
  - data.openId
  - data.unionId
- 额外说明：
  - grantCode 只有 10 分钟有效期
  - 文档明确建议服务端调用

### 8. 批量添加歌曲到歌单

- 名称：批量添加歌曲到歌单
- 路径：/openapi/music/basic/playlist/song/batch/like
- 方法：GET/POST
- bizContent 关键参数：
  - playlistId: string, 必填
  - songIdList: List<String>, 必填
- 对当前项目的价值：
  - 审核通过后，将点歌歌曲批量写入你的目标歌单
- 关键返回：
  - data: true
- 约束：
  - 文档明确说明“需是自己的”歌单

### 9. 获取歌单详情

- 名称：获取歌单详情
- 路径：/openapi/music/basic/playlist/detail/get/v2
- 方法：GET/POST
- 对当前项目的价值：
  - 可读取目标歌单摘要、trackCount、trackUpdateTime 等信息
  - 可配合“歌单歌曲列表”做后台同步校验

### 10. 获取歌单里的歌曲列表

- 名称：获取歌单里的歌曲列表
- 路径：/openapi/music/basic/playlist/song/list/get/v3
- 方法：GET/POST
- bizContent 关键参数：
  - playlistId: String, 必填
  - limit: Int, 必填，最大 500
  - offset: Int, 必填
  - qualityFlag: Boolean, 可选
- 对当前项目的价值：
  - 可以拉取目标歌单已有歌曲，避免重复写入
  - 可以把歌单内容回显到管理台，替代当前纯手动导出
- 关键返回：
  - data[].id
  - data[].name
  - data[].artists[]
  - data[].playFlag
  - data[].vipFlag
  - data[].liked
  - data[].visible
- 关键业务含义：
  - subCode=10007 常见于歌单为空、offset 超界或歌单不可见

### 11. 获取最近播放歌单列表

- 名称：获取最近播放歌单列表
- 路径：/openapi/music/basic/playlist/play/record/list
- 方法：GET/POST
- bizContent 关键参数：
  - limit: Int, 可选，默认 100
- 对当前项目的价值：
  - 可作为主机侧“最近常播歌单快捷导入”入口
  - 也可以在首次配置时辅助用户快速挑选一个已有歌单作为同步目标
- 关键返回：
  - data.records[].record.id
  - data.records[].record.name
  - data.records[].record.trackCount
  - data.records[].record.creatorNickName
  - data.records[].playTime

## 之前误链的修正

- 之前给的 docId=730b0a8b80e745dea3b9f354eddb467e 实际是“获取歌单详情”，不是“获取最近播放歌曲列表”
- 这次提供的 docId=e185b8877e144eba82d8eefd7a7f1081 才是“获取最近播放歌单列表”

## 对当前项目的直接编码顺序

### 第一优先级

1. 综合搜索
2. 获取歌曲播放 URL
3. 批量添加歌曲到歌单

### 第二优先级

1. 匿名登录
2. 获取登录二维码
3. 轮询二维码状态
4. 刷新 AccessToken
5. 回调 code 换取 accessToken

### 第三优先级

1. 获取歌单详情
2. 获取歌单里的歌曲列表
3. 获取最近播放歌单列表
4. 做歌单去重与同步回显

## 当前仍缺少的官方页面或实现点

为了真正接入官方模式，文档层面现在主要还缺这些页面，工程层面则要开始写正式请求层：

1. 如果要做最近播放歌曲兜底，再提供“获取最近播放歌曲列表”的正确页面
2. 把 RSA 签名、公共参数拼装、token 生命周期管理真正写进服务端
3. 把匿名登录、二维码轮询、refresh token 续期真正写成服务端可调用流程
