# Repository Agent 说明

## 本地认证：用于 Trace 调查

* 在本地进行 API 重放、Trace 调试和回归探测时，不要复制浏览器中的 `qasey_session` Cookie。请使用专用的开发环境 Bearer Token。

* 真正的 `QASEY_DEV_AUTH_TOKEN` 存放在被 Git 忽略的 `.env.local` 中。**绝对不要打印、记录日志、粘贴到聊天中，或提交其值。**

* 请通过标准环境加载器加载仓库环境文件，确保 `.env.local` 和编码后的 `.env.secret` 按正确的优先级生效：

  ```bash
  pnpm exec moego-aws-secret-env run --default-environment testing -- <command>
  ```

* 子命令应通过 `process.env.QASEY_DEV_AUTH_TOKEN` 读取 Token，并发送以下请求头：

  ```text
  Authorization: Bearer <token>
  ```

  只检查该环境变量**是否存在**，不要使用 `cat`、`echo` 或其他可能暴露 Token 内容的命令。

* 该 Token 仅在 `NODE_ENV=development` 时生效，并会解析为服务端持有的 `local-developer` 身份：

  * Tenant：`local-development`
  * 权限：`platform-admin`

  测试环境会忽略该 Token，生产环境配置则会直接拒绝它。

* 该 Header 仅用于受保护的 Admin API、普通 API 和 Studio API 请求。它**不能替代 Slack/Jira 的请求签名**，也不要将其添加到需要签名验证的渠道 Webhook 重放请求中。

* 浏览器中的 Admin UI 和 Studio Session 仍然继续使用 Google OAuth Cookie。**绝对不要将开发 Token 编译进前端静态资源或前端 Bundle 中。**

* 项目实际使用的 API 前缀是：

  ```text
  /studio/api
  ```
