# Plan: 飞书文档 MCP Tools (n8n)

## 目标

在 n8n 上构建两个 MCP Tool，对外暴露飞书文档的**读取**和**搜索**能力。

## 需求确认

| 项 | 决策 |
|---|---|
| 暴露方式 | n8n MCP Server（workflow 即 tool） |
| 飞书认证 | 用户 OAuth → n8n Generic OAuth2 Credential 自动管理 |
| 搜索范围 | 全量（用户授权范围内所有文档） |
| 返回格式 | Markdown / 纯文本 |
| n8n 部署 | 自部署，有公网地址 |
| MCP 消费方 | 待定（先把 tool 建好） |

---

## 架构

```
┌─────────────────────────────────────────────┐
│  MCP Consumer (Claude / Agent / etc.)       │
└──────────────┬──────────────────────────────┘
               │ MCP Protocol
               ▼
┌─────────────────────────────────────────────┐
│  n8n Instance (self-hosted, MCP enabled)    │
│                                             │
│  Workflow 1: lark_doc_read                  │
│  ┌─────────────────────────────────────┐    │
│  │ Execute Workflow Trigger             │    │
│  │ → HTTP Request (get blocks)         │    │
│  │ → Code (blocks → markdown)          │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Workflow 2: lark_doc_search               │
│  ┌─────────────────────────────────────┐    │
│  │ Execute Workflow Trigger             │    │
│  │ → HTTP Request (search API)         │    │
│  │ → Code (format results)             │    │
│  └─────────────────────────────────────┘    │
└──────────────┬──────────────────────────────┘
               │ HTTPS (OAuth user_access_token)
               ▼
┌─────────────────────────────────────────────┐
│  飞书开放平台 API                            │
└─────────────────────────────────────────────┘
```

---

## 实施步骤

### Phase 1: 飞书开放平台准备（用户手动）

1. **创建企业自建应用**（飞书开放平台 → 创建应用）
2. **配置权限 Scopes**:
   - `docx:document:readonly` — 读取新版文档
   - `wiki:wiki:readonly` — 读取知识库
   - `search:docs:read` — 搜索文档
3. **配置 OAuth 回调地址**:
   ```
   https://<n8n-domain>/rest/oauth2-credential/callback
   ```
4. **发布应用版本**（审核通过后生效）
5. 记录 `app_id` 和 `app_secret`

### Phase 2: n8n Credential 配置（用户手动）

创建一个 **Generic OAuth2 API** credential：

| 字段 | 值 |
|---|---|
| Grant Type | Authorization Code |
| Authorization URL | `https://open.feishu.cn/open-apis/authen/v1/authorize` |
| Access Token URL | `https://open.feishu.cn/open-apis/authen/v1/access_token` |
| Client ID | `<飞书 app_id>` |
| Client Secret | `<飞书 app_secret>` |
| Scope | `docx:document:readonly wiki:wiki:readonly search:docs:read` |
| Auth URI Query Parameters | `app_id={{$credentials.clientId}}` |
| Authentication | Send in Body |

> **注意**: 飞书 OAuth 的 token endpoint 需要在 body 中传 `app_id` + `app_secret`（而非标准 Basic Auth header）。可能需要在 n8n 中选 "Body" 方式发送 client credentials。

### Phase 3: 构建 Workflow 1 — `lark_doc_read`

**功能**: 根据文档 ID 读取飞书文档内容，转为 Markdown 返回。

**输入参数**:
- `document_id` (string, required) — 飞书文档 ID（如 `doccnXXXXX`）

**飞书 API 调用**:
1. `GET /open-apis/docx/v1/documents/{document_id}/blocks?page_size=500`
   - 分页获取所有 block
2. Code Node: 递归将 block 转为 Markdown

**Block → Markdown 转换逻辑**:
| Block Type | 转换规则 |
|---|---|
| page | 文档标题 → `# title` |
| heading1/2/3/... | `## ` / `### ` / ... |
| text | 拼接 TextRun 的 content |
| bullet / ordered | `- ` / `1. ` |
| code | ` ``` ` 包裹 |
| quote | `> ` 前缀 |
| divider | `---` |
| image | `![](url)` （如果有公开 URL） |
| table | Markdown table |
| 其他 | 忽略或简单文本化 |

**输出**: `{ content: string, title: string, url: string }`

### Phase 4: 构建 Workflow 2 — `lark_doc_search`

**功能**: 全文搜索飞书文档，返回结果列表。

**输入参数**:
- `query` (string, required) — 搜索关键词
- `count` (number, optional, default=10) — 返回数量，最大 50

**飞书 API 调用**:
- `POST /open-apis/suite/docs-api/search/object`
  ```json
  {
    "search_key": "{{query}}",
    "count": {{count}},
    "docs_token_list": [],
    "owner_id_list": [],
    "chat_id_list": [],
    "docs_type_list": []
  }
  ```

**输出**:
```json
{
  "results": [
    {
      "title": "文档标题",
      "url": "https://xxx.feishu.cn/docx/xxx",
      "doc_type": "docx",
      "owner": "张三",
      "preview": "摘要文本...",
      "create_time": "2024-01-01T00:00:00Z",
      "update_time": "2024-06-01T00:00:00Z"
    }
  ],
  "total": 42
}
```

### Phase 5: 验证 & 发布

1. `validate_workflow` 检查两个 workflow 的 SDK 代码
2. `get_workflow_details` 确认 connections 正确
3. 用 `test_workflow` + pin data 测试（需要用户先完成 OAuth 授权）
4. `publish_workflow` 激活
5. 确认 MCP access 已开启（agent 创建的 workflow 默认开启）

### Phase 6: 交付 & 文档

- 告知用户如何在 MCP client 中连接 n8n MCP server
- 两个 tool 的使用方式：
  - `lark_doc_read({ document_id: "doccnXXX" })`
  - `lark_doc_search({ query: "关键词", count: 10 })`

---

## 风险 & 待确认

| 风险 | 影响 | 缓解 |
|---|---|---|
| 飞书 OAuth token 刷新 | n8n Generic OAuth2 不一定完美兼容飞书的 refresh 流程 | 可能需要在 Code node 中手动处理 token refresh |
| 飞书 block 类型多样 | 部分复杂 block（嵌套表格、多维表格等）难以完美转 Markdown | 先覆盖常用类型，复杂类型降级为纯文本 |
| 搜索 API 权限范围 | 搜索结果受 user_access_token 对应用户的可见范围限制 | 这是预期行为，文档中说明 |
| n8n 版本要求 | MCP Server 功能需要 n8n >= 1.64 | 确认用户 n8n 版本 |

---

## 下一步

用户确认此 plan 后，按 Phase 3 → Phase 4 顺序实现，通过 n8n MCP 工具 `create_workflow_from_code` 创建工作流。
