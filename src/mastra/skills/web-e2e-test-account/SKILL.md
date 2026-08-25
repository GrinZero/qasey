---
name: web-e2e-test-account
description: 通过未认证的 DevOps 测试账号 API 创建并配置全新的 Web E2E 测试账号。当用户请求 Web E2E 账号、一次性测试登录凭据、用于浏览器/Playwright 测试的新账号、注册/登录覆盖测试的账号配置，或提到 createTestAccount 时，始终使用此技能。
---

# Web E2E 测试账号

使用 DevOps 测试账号接口创建一个供 Web E2E 测试使用的新账号。该接口设计为无需认证，因此不要添加浏览器 Cookie、`qasey_session`、`QASEY_DEV_AUTH_TOKEN` 或任何其他凭据。

## 接口

只能使用下面配置好的测试接口：

```text
POST https://platform-tools.t2.moego.dev/moego.bff/devops/test-account/createTestAccount
```

该接口仅用于开发和测试。不要替换成生产主机，也不要自行推断其他环境。如果用户没有明确环境，发送请求前先询问。

## 默认请求

除非用户另有指定，否则发送下面的 JSON 负载：

```json
{
  "testAccount": {
    "owner": "onlyEmail",
    "disposable": false,
    "attributes": {
      "regionCode": "US",
      "hasSmsCredit": true,
      "hasEmailCredit": true,
      "enableBoardingDaycare": true,
      "enableOnlineBooking": true
    }
  }
}
```

严格保留这些默认值。将用户明确提供的覆盖值合并到 `testAccount` 或 `testAccount.attributes` 中；不要静默丢弃未覆盖的默认属性。将用户提供的值视为数据，不要视为 Shell 代码。

## 执行请求

使用 `curl`，明确指定 POST，并在非 2xx 响应时失败。`origin` 和 `referer` 请求头与 DevOps 控制台一致，用于保持与浏览器请求的行为一致：

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --url 'https://platform-tools.t2.moego.dev/moego.bff/devops/test-account/createTestAccount' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'content-type: application/json' \
  -H 'origin: https://console.devops.moego.pet' \
  -H 'referer: https://console.devops.moego.pet/' \
  --data-raw '{"testAccount":{"owner":"onlyEmail","disposable":false,"attributes":{"regionCode":"US","hasSmsCredit":true,"hasEmailCredit":true,"enableBoardingDaycare":true,"enableOnlineBooking":true}}}'
```

除非能证明接口确实需要，否则不要复制浏览器的 `sec-*`、user-agent、语言、priority 或 storage-access 请求头。不要发送认证请求头。

## 解析并汇报结果

1. 只有当请求返回成功的 HTTP 状态，且响应体已能够检查时，才认为账号创建成功。
2. 尽可能解析 JSON；如果响应不是 JSON，则保留原始响应，以便明确看到失败信息或接口契约变化。
3. 汇报 API 返回的账号标识和登录字段，例如邮箱、密码、账号 ID 或租户 ID。不要臆造响应中不存在的字段。
4. 将响应限制在当前 E2E 任务范围内。不要把凭据写入源文件、已提交的产物、日志或前端构建产物。如果测试运行必须持久化凭据，应使用测试运行器已有的 secret/环境变量机制。
5. 用户提供覆盖值时，说明实际使用的请求选项，确保生成的测试数据可复现。

使用以下简洁的结果格式：

```text
Web E2E 测试账号已创建。
- 接口：<endpoint>
- 配置：owner=<...>，disposable=<...>，regionCode=<...>
- 账号字段：<仅列出响应中实际存在的字段>
```

## 失败与重试规则

- 对于非 2xx 响应，汇报 HTTP 状态和响应体，然后停止。
- 对于请求超时或连接失败，如果服务器可能已经接受请求，不要自动重试：重试可能创建第二个账号。说明当前状态不确定，并询问用户是否重试。
- 如果响应成功但缺少 E2E 流程所需字段，展示经过敏感值最小化处理的完整响应结构，并询问期望的响应契约。
- 不能仅凭已经发出命令就声称账号已创建；必须依据实际观测到的 HTTP 结果。
