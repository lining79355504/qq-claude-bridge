# NapCat / OneBot 兼容接入

需要 Node.js >= 22.13，推荐 Node.js 24；安装并登录 Claude Code，先确认在工作目录中能正常运行 `claude`。SQLite 使用 Node 内置模块。

```bash
cd ~/Downloads/qq-claude-bridge
# 使用 nvm 时：nvm use 24
npm ci
cp .env.example .env
```

在 NapCat 的网络配置中新增并启用 **WebSocket 服务器（正向 WS）**：

- 地址设为 `127.0.0.1`，端口例如 `3001`。
- 设置一个访问 token，桥接通过 `Authorization: Bearer ...` 发送。
- 开启消息事件上报，消息格式建议选择数组；CQ 字符串格式也支持。
- 使用同时支持事件和 API 的 WebSocket 地址；不要填 WebUI 端口或反向 WS 地址。
- 用 QQ 客户端完成登录，让用于控制的 QQ 号成为机器人 QQ 的好友。

填写 `.env`：

```dotenv
QQ_TRANSPORT=onebot
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=与NapCat设置一致的token
QQ_ALLOWED_USER_IDS=你的QQ号
QQ_ALLOWED_GROUP_IDS=
CLAUDE_WORKSPACE=/你的仓库绝对路径
```

群聊需要同时设置 `QQ_ALLOWED_GROUP_IDS=群号`，多个用户或群号用英文逗号分隔。群白名单留空表示禁用群聊；群内操作者仍须在用户白名单中。默认每次消息、命令和审批回复都必须真正 **@机器人**，仅输入文字“@机器人”无效。

跨机器接入可使用 `wss://` 或 SSH 隧道转发到本机端口；非本机的明文 `ws://` 地址会被配置检查拒绝。远程 NapCat / Docker 端口需按其部署方式映射到上述地址。

```bash
npm run check
npm start
```

日志显示 `QQ ... 已连接` 后，私聊发送 `/help`，或在允许的群中 `@机器人 /help`。

使用此方式必须显式设置 `QQ_TRANSPORT=onebot`。

`check` 只检查配置、依赖和 CLI 版本，不验证 QQ 连通性或 Claude 登录态。缺少 token、QQ 白名单或工作目录时拒绝启动。

## 扫码绑定机器人 QQ

先运行 NapCat，完成上面的 OneBot 配置，然后执行：

```bash
npm run login:onebot
# 不自动打开浏览器时：
npm run login:onebot -- --no-open
```

命令打开 `NAPCAT_WEBUI_URL`（默认 `http://127.0.0.1:6099`）。在 NapCat 页面输入 **WebUI token**，用手机 QQ 扫描页面上的登录二维码并确认。二维码生成、刷新及手机确认由 NapCat 处理。WebUI token 与 `ONEBOT_ACCESS_TOKEN` 是两个独立配置，WebUI token 无需填写到桥接项目中。

桥接等待 OneBot 返回登录成功，自动把 QQ 号写入 `.env` 的 `QQ_BOT_ID`，随后退出。再运行 `npm start` 即可。启动及重连时都会校验当前 QQ 与绑定账号一致，不匹配时不会接收 QQ 任务。

- 已有登录态时直接绑定当前 QQ，不会强制弹出新的二维码。换号请先停止桥接，在 NapCat 退出旧账号，再运行登录命令。
- 等待上限为 10 分钟，Ctrl+C 取消；未登录成功不会修改绑定。
- 登录命令只需要 `.env` 中的 OneBot 地址、token 和 WebUI 地址；绑定后还需配置操作者白名单与工作目录。机器人账号不会自动加入操作者白名单。
- NapCat 必须已安装运行，且正向 WebSocket 服务已启用。此入口通过 NapCat WebUI 扫码，不提供独立于 NapCat 的 QQ 登录协议。
- QQ 登录态由 NapCat 保存；桥接仅保存绑定的 QQ 号，不保存 QQ 密码或二维码。未绑定时仍兼容原有直接连接方式。


## 图片

兼容接入也支持收图分析和图片回传，限制与使用方式见主 README 的“图片分析与图片回传”。NapCat 事件需提供可下载的 QQ CDN 图片 URL；仅有本机文件标识、无下载 URL 的事件会明确报错。图片回传通过 OneBot `image` 消息段发送 base64 文件内容。
