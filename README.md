# qq-claude-bridge

仿照 `wecom-claude-bridge`，通过 QQ 机器人操控本机 Claude Code，支持工单、会话恢复、人工审批和定时任务。

默认使用 **QQ 官方机器人 + `@tencent-connect/qqbot-connector` 终端扫码绑定**，无需 NapCat。原有 NapCat / OneBot 模式保留为可选接入，见 [NapCat 接入](docs/NapCat接入.md)。

```text
手机 QQ 扫码确认 → qqbot-connector → AppID / AppSecret
                                         ↓
QQ 私聊 / 群 @机器人 ↔ 官方网关与消息 API ↔ 工单、审批、定时任务 ↔ Claude Code
```

## 安装与扫码绑定

需要 Node.js >= 22.13，推荐 Node.js 24，以及已安装并登录的 Claude Code。SQLite 使用 Node 内置模块。

```bash
cd ~/Downloads/qq-claude-bridge
# 使用 nvm 时：nvm use 24
npm ci
npm run login
```

`npm run login` 直接在终端显示二维码。使用手机 QQ 扫码并按页面提示确认机器人授权；二维码过期会自动刷新，10 分钟超时，Ctrl+C 取消。此流程绑定 QQ 开放平台机器人，不会把手机 QQ 个人账号登录到桥接进程。

成功后自动创建/更新 `.env`，写入 `QQ_TRANSPORT=official`、`QQBOT_APP_ID`、`QQBOT_APP_SECRET`。文件权限为 `0600`，不打印 AppSecret。换绑前停止桥接进程；SDK 若返回多个机器人，使用 `npm run login -- --app-id 应用ID` 指定。

随后编辑 `.env`：

```dotenv
CLAUDE_WORKSPACE=/你的仓库绝对路径
# 以扫码返回或消息事件日志中的 OpenID 为准；多个用英文逗号分隔
QQBOT_ALLOWED_USER_IDS=操作者OpenID
# 留空禁用群聊，群内用户仍须在用户白名单中
QQBOT_ALLOWED_GROUP_IDS=
```

如果扫码已经填入正确的操作者 OpenID，无需替换；若 SDK 没返回该字段，会填入 `bootstrap-deny-all`。先配置工作目录并启动，给机器人发一条文字消息，查看本地 `拒绝非白名单消息：用户 OpenID=...` 日志，确认是自己的消息后填写并重启。此过程中消息不会执行 Claude。群 OpenID 可用相同方式从群 @事件的拒绝日志获取。

```bash
npm run check
npm start
```

日志出现 `QQ 官方应用 ... 已连接` 后，在机器人私聊发送 `/help`，或在允许的群中 @机器人发送 `/help`。是否可添加到群、接收群事件或主动推送，取决于该应用的平台权限。

`check` 仅检查本地配置、依赖与 CLI 版本，不验证 QQ 权限或 Claude 登录态。`.env` 中保存应用密钥，请勿提交 Git；扫码入口不调用 Claude，也不向联系人发送消息。

## 工单和审批

```text
/new 修复登录接口超时
只改后端，不动前端
/status
/history
/stop
/resume
/close
```

| 命令 | 含义 |
|---|---|
| `/new 需求` | 创建并执行新工单 |
| `/list` | 当前聊天最近 20 张工单 |
| `/switch 编号` | 切换后续消息所属工单 |
| `/status [编号]` | 状态、队列、目录、待审批编号 |
| `/history [编号]` | 最近 10 条记录，每条预览最多 500 字符 |
| `/stop [编号]` | 停止执行并取消该工单排队消息 |
| `/resume [编号]` | 恢复暂停任务或继续处理 |
| `/close [编号]` | 验收并关闭工单 |
| `/reset`、`/clear` | 清空当前 Claude 会话，保留历史 |
| `/image 图片路径` | 直接发送已有图片，不调用 Claude；支持 `~` 和带空格的路径 |
| `/help` | 查看帮助 |

普通消息自动创建工单或归入当前工单；执行中的补充消息排队处理。交互工单串行执行，各工单独立 Claude 会话。私聊和群聊彼此隔离，同一群的白名单成员共享工单。

Claude 请求工具审批时，回复 `y 完整审批编号` 同意或 `n 完整审批编号` 拒绝。裸 `y/n`、其他聊天的编号或过期编号不会批准操作。默认 5 分钟超时拒绝，群聊审批也要 @机器人。

`CLAUDE_PERMISSION_MODE` 支持 `default`、`acceptEdits`、`auto`，沿用参考项目的权限行为。`default` 下只读工具及识别为只读的 Bash 自动放行，其余请求审批；`auto` 的可用性取决于账号和模型。目录围栏及禁用工具规则在所有模式下先行检查。

## 图片分析与图片回传

重启桥接后，直接在 QQ 发图片即可让 Claude 分析，也可以附上文字：

```text
这张截图为什么报错？
/new 根据这张设计图修改页面
把页面截图发给我
画一张调用关系图，生成 PNG 发回来
把工作目录里的 result.png 发给我
```

已有截图也可直接发送，无需让 Claude 再截图：

```text
/image ~/Downloads/screenshot.png
/image "带空格的目录/screen shot.png"
```

路径以当前工单的工作目录为基准，没有当前工单时使用配置的工作目录；仍检查实际路径、允许范围和禁用规则。此命令只发送图片，不创建新工单、不调用模型。

支持单独图片、文字附图和同一条消息多图。群聊仍须 @机器人，并满足用户和群白名单。单条最多 **4 张**，单张最多 **5 MiB**，支持 **PNG、JPEG、GIF、WebP**；其他格式请先转换。图片超限、下载失败或格式不支持会明确提示，本条需求不会以缺图状态继续执行。

收到的图片会下载并随工单消息存入 SQLite，作为真正的图片内容传给 Claude，不依赖模型访问临时下载链接。排队和进程重启后的 `/resume` 可继续读取图片。现有数据库启动时自动增加附件字段，原有工单保留；`/history` 只显示附图数量。数据库会因图片增长，备份时也包含图片内容。

Claude 通过专用 `mcp__qq__send_image` 工具发送已经生成的图片。该工具始终加载，每轮恢复会话时都会补充当前附件能力说明，避免沿用旧对话中“不能发图”的说法；目标固定为当前任务的 QQ 聊天。只读取当前工单工作目录且符合 `CLAUDE_ALLOWED_PATHS` 的文件，解析符号链接后再检查范围；截图请让 Claude 保存到工作目录。可通过 `DENIED_TOOLS=mcp__qq__send_image` 禁用发送。

发图工具负责上传和发送，不自带图像生成模型或浏览器；Claude 能生成哪些图片、能否截图，取决于本机可用工具和环境。普通生成脚本、浏览器截图等操作仍遵循当前 Claude 权限模式。

官方通道先上传文件再发送图片消息，图片与文字共用被动回复窗口、条数额度和发送队列。只有收到消息回执才报告发送成功。上传/发送失败会返回给 Claude；超时仍可能已经在远端送达，不自动重放。可以重新发消息要求“把刚才的图再发一次”，工作目录中的图片需仍存在。

定时任务的 QQ 目标也可使用发图工具，但图片是在执行期间发送，不进入文本结果的持久化重试队列，`/schedule retry` 只重发文字结果；企微 Webhook 目标暂不支持此发图工具。图片收发已通过本地模拟验证，真实账号的图片 API 权限和平台额度需实测。

## 定时任务

```text
/schedule add every 30m -- 检查仓库状态，汇总最近提交
/schedule add daily 09:00 --timezone Asia/Shanghai -- 总结昨天的工作
/schedule add once 2027-01-01T09:00+08:00 -- 检查发布状态
/schedule add every 2h --workspace "/绝对路径/项目" -- 检查这个项目
/schedule list
/schedule show 1
/schedule run 1
/schedule history 1
```

默认向创建任务的 QQ 私聊或群聊发送结果。官方通道受被动回复窗口和主动消息权限约束，详见下文；没有主动消息权限时，定时任务仍可执行并保存结果，但不保证到点推送。还保留原项目的 `--webhook https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...` 可选出口，用于把结果发往**企业微信群机器人**；它不是 QQ Webhook，也不需要企微 SDK。

| 命令 | 含义 |
|---|---|
| `/schedule pause 编号` | 暂停后续触发，当前执行继续 |
| `/schedule resume 编号` | 恢复调度 |
| `/schedule stop 编号` | 中止当前运行及排队项，周期保留 |
| `/schedule delete 编号` | 停止调度、取消执行及未发送结果，保留历史 |
| `/schedule retry 运行编号` | 重发已保存结果，不重新调用 Claude |
| `/schedule approve 审批编号` | 同意指定定时运行的审批 |
| `/schedule reject 审批编号` | 拒绝指定定时运行的审批 |
| `/schedule help` | 完整用法 |

定时任务默认最多并发 4 个，每次独立会话，最多 100 轮、30 分钟超时；同一任务不会重叠运行。它们与交互工单共用文件系统，修改同一仓库时需自行使用不同工作目录或 worktree。每日任务按配置时区调度，`once` 必须带时区，机器休眠时无法准点执行。

## 官方通道的消息与权限

- 扫码通过 `@tencent-connect/qqbot-connector@1.2.0` 完成，SDK 获取 AppID / AppSecret；消息通道另外使用 QQ 机器人 HTTP API 和 WebSocket 网关。
- 接收私聊 `C2C_MESSAGE_CREATE` 和群 @事件 `GROUP_AT_MESSAGE_CREATE`。支持文字和图片，文件附件、语音和频道暂不支持。是否能使用这些事件取决于应用权限及平台策略。
- 官方通道白名单使用 **OpenID，不是数字 QQ 号**。用户与群分别填写 `QQBOT_ALLOWED_USER_IDS`、`QQBOT_ALLOWED_GROUP_IDS`，同一个人在不同场景的标识以平台实际事件为准。
- 扫码 SDK 1.2.0 的实现可能额外返回 `userOpenid`，首次绑定时用于初始化操作者白名单。该字段不在公开类型声明中；缺失时填 `bootstrap-deny-all` 拒绝所有人，日志提示手工配置。再次绑定同一应用保留已有白名单，换应用会清空旧应用的用户/群授权。
- 平台对被动回复有时间和数量限制。本实现保守地在收到消息后最多 4 分钟内、每个消息 ID 最多尝试 5 段回复；这是本地策略，不代表平台保证可发送的额度。平台可能更严格。
- 默认关闭工具进度播报，把回复额度留给需求确认、审批和最终结果。结果过长、任务耗时过久或平台拒绝发送时，全文仍保存在 SQLite 中；发 `/history` 查看最近记录预览，或用 `/status` 查询任务。
- `QQBOT_ALLOW_PROACTIVE=false` 时，没有可用被动回复就返回发送失败。只有应用已具备主动消息权限才设置 `true`；此开关不会赋予平台权限。未获许可或超过平台额度，定时推送和长任务主动回复仍可能失败。
- 纯文本按 UTF-8 分段发送，所有 QQ 出站消息共用最小发送间隔，平台对链接、内容和频率仍可能另有限制。工单、审批提示中的 Markdown 标记可能以普通文本展示。
- HTTP 发送失败不会自动重复调用模型。交互结果保存在工单中；定时任务结果进入持久化推送队列，自动重试耗尽后可用 `/schedule retry 运行编号` 重发。

## 断线与持久化

网关支持心跳、断线重连和会话 Resume；无效会话重新 Identify。鉴权或事件权限被拒绝时停止连接并提示检查配置。进程重启后不会恢复网关会话，但会从数据库恢复工单记录。

默认官方数据库为 `data/qqbot-<AppID>.sqlite`，聊天键包含应用 ID；OneBot 继续使用 `data/tickets.sqlite`。换应用或接入方式不会自动迁移工单。每个数据库只运行一个桥接进程；自定义 `TICKET_DB_PATH` 时也应为不同应用使用不同文件。

交互工单重启后暂停、旧审批失效，需要 `/resume`；已经发生的文件修改不会回滚。Claude 恢复还依赖本机 Claude 会话文件。定时任务中断的单次执行不会自动重跑，之后周期继续，已生成的待推送结果恢复发送。

消息 ID 在内存中去重 10 分钟，最多 10000 条，重启不保留。网络超时不代表远端未接收，定时重试可能重复发送。平台没有提供本项目可依赖的跨重启幂等保证。

白名单成员能驱动本机 Claude 执行工具。目录围栏继承原项目的路径检查，**不是操作系统沙箱**；Shell 间接寻址和符号链接等不能靠它提供完整隔离。

## 验证

```bash
npm test
# 在允许监听本机端口的终端验证真实 WebSocket 协议收发：
QQ_REAL_SOCKET_TESTS=1 node --test test/qq.test.js
```

默认测试使用模拟 Claude、QQ 官方 HTTP/网关响应、OneBot 连接和临时 SQLite，覆盖扫码凭据、取消、白名单、Token 刷新、网关 Resume、回复限制，以及图片下载、Claude 图片输入、图片发送、附件持久化、工单、审批和定时任务。测试不会发送真实 QQ 消息或消耗模型额度。真实扫码、账号权限和平台额度尚需联网实测，验证边界见 [官方通道验证](docs/官方通道验证.md)。

目录说明与排障见 [使用与排障](docs/使用与排障.md)。

## 来源

核心模块改编自同级目录 `wecom-claude-bridge`，保留其 Apache-2.0 LICENSE。第三方依赖按各自包内许可声明管理，不由本项目 LICENSE 覆盖。扫码 SDK 使用用户提供的本地 tgz；离线二维码依赖来源见 [vendor/README.md](vendor/README.md)。未复制参考项目的账号配置、工单数据库或 Claude 会话。
