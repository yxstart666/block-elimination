# 微信排行榜接入

当前配置关闭，不会请求云函数，也不会生成虚构榜单。需要自己的正式微信 AppID 和云开发环境。

1. 在云开发中创建 `wood_block_scores` 和 `wood_block_players` 集合，两者的客户端读写权限均设为禁止，仅由云函数访问。
2. 在项目根目录执行 `node cloudfunctions/leaderboard/sync-levels.mjs`，同步当前 30 关的预算及星级分数线。修改关卡后重新同步。
3. 将本目录作为名为 `leaderboard` 的云函数上传，在云端安装依赖，并设置环境变量 `LEADERBOARD_APPID` 为该小程序或小游戏的真实 AppID。
4. 按控制台提示创建索引：单关集合依次为 `levelId` 升序、`score` 降序、`achievedAt` 升序、`_id` 升序；总榜集合为 `score` 降序、`achievedAt` 升序、`_id` 升序。
5. 在 `src/config/leaderboard.ts` 中填入环境 ID，将 `enabled` 设为 `true`，重新构建。

单关榜保存每个用户在该关的最高分；总分榜累加每关最高分，重复刷同一成绩不会累加。分数相同按先达到的时间排序，再用记录 ID 保持稳定顺序。星级由服务器上的分数线计算；昵称暂用服务器生成的匿名玩家名，不自动获取头像或个人昵称。

云函数只采用 `getWXContext()` 返回的身份，忽略客户端身份字段，并用事务保持分数只升不降。包含分数范围、步数上界和星级一致性校验；**尚未校验完整落子轨迹或广告凭据，不属于完整的竞争防作弊服务**。正式开放竞争前，应接入服务器重放、限流与审核。不得在客户端放 AppSecret 或云数据库管理员密钥。

## 微信好友榜

普通微信小程序不能直接调用小游戏开放数据域的好友数据接口；当前该入口明确显示未接入。若需要普通小程序好友关系榜，应另接基于用户主动添加／邀请的好友关系服务，不伪装成读取微信通讯录。

小游戏工程已带 `open-data/index.js` 和 `game.json` 的 `openDataContext` 配置。开通相应能力后，将 `friendsOpenData` 设为 `true`。每次云端确认最高分后，小游戏通过 `wx.setUserCloudStorage` 同步单关及总分。好友分数由开放数据域调用 `wx.getFriendCloudStorage` 并直接画到 sharedCanvas；主域只显示画布，不读回或上传好友数据。UI 在好友页调用 `load('friends', levelId)`，随后通过 `drawFriends(context, rect)` 绘制，并在关闭时调用 `hideFriends()`。

需要用真实微信账号和至少两名同玩好友真机验收，浏览器与测试 AppID 无法证明真实用户榜或好友榜已经接通。

官方资料：[微信小游戏 API 类型与开放数据域](https://github.com/wechat-miniprogram/minigame-api-typings)、[微信云开发 Server SDK](https://github.com/wechat-miniprogram/wx-server-sdk)。
