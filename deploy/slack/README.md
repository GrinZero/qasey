# Slack App 配置

`manifest.json` 是生产 HTTP Events API 配置。导入前确认 `qasey.devops.moego.pet` 已经路由到 Shared Mastra Runtime 的 `/studio/api/agents/qasey-main/channels/slack/webhook`；如果实际域名不同，同时替换 Events 和 Interactivity 两处 URL。签名校验、DM/mention、streaming、thread mapping、attachments 和 approval 均由 Mastra Channels 的 Slack adapter 处理，不再部署独立 Bolt receiver 或 queue worker。

`manifest.testing.json` 仅用于 testing Slack App。它额外注册 `/qasey-local` 和 `commands` scope，所有 Request URL 指向 `qasey.t2.moego.dev`。应用该 manifest 后需要重新安装 testing App；不要把该 Slash Command 合并到生产 manifest。

Admin UI 管理的 Slack App 可以为每条 Trigger connection 配置独立的本地 Runtime Slash Command；留空时默认使用 `/qasey-local`。Qasey 只处理该 command，仍需在对应 Slack App 后台创建同名 Slash Command，并把 connection 展示的 Request URL 填入 Slack。

本地开发建议在 Slack App 设置中临时启用 Socket Mode，并创建带 `connections:write` 的 app-level token，配置：

```env
SLACK_SOCKET_MODE_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_USER_TOKEN=xoxp-...
```

`SLACK_USER_TOKEN` 对应 manifest 的 user scope `search:read`，仅用于 `search.messages`；其余 Slack API 均使用 bot token。修改 scopes 后需要重新安装 App 到 workspace。

当前 Slack manifest 使用 `agent_view` 模式，因此订阅 `app_home_opened` 与 `message.im`。不要在同一 manifest 中加入 `assistant_thread_started`；那属于另一套 Assistant thread event 模式，Slack manifest 校验器会将两者判定为冲突。

生产切换前请在 Slack test app 完成签名、重复 delivery、thread queue、attachment 和 approval smoke test。
