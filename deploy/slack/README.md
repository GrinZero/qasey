# Slack App 配置

`manifest.json` 是生产 HTTP Events API 配置。导入前确认 `qasey.devops.moego.pet` 已经路由到 `qasey-slack` Service 的 `/slack/events`；如果实际域名不同，同时替换 Events 和 Interactivity 两处 URL。

本地开发建议在 Slack App 设置中临时启用 Socket Mode，并创建带 `connections:write` 的 app-level token，配置：

```env
SLACK_SOCKET_MODE_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_USER_TOKEN=xoxp-...
```

`SLACK_USER_TOKEN` 对应 manifest 的 user scope `search:read`，仅用于 `search.messages`；其余 Slack API 均使用 bot token。修改 scopes 后需要重新安装 App 到 workspace。

当前 Slack manifest 使用 `agent_view` 模式，因此订阅 `app_home_opened` 与 `message.im`。不要在同一 manifest 中加入 `assistant_thread_started`；那属于另一套 Assistant thread event 模式，Slack manifest 校验器会将两者判定为冲突。

n8n OAuth redirect URL 暂时保留用于迁移期回滚。完全切流并确认不再由 n8n 重连 OAuth 后再删除。
