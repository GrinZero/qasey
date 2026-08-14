# Plan: QA 经验记忆 MCP Tools (n8n)

## 目标

给 QA agent 一套「简单记忆机制」：把飞书上人工维护的 QA 经验当成一个**只读文件系统**暴露给
agent。真人 QA 在飞书里手动加文档即生效，无需任何同步步骤。

两个数据源（均为 wiki node token）：

| 用途 | 链接 | token |
|---|---|---|
| 测试维度检查清单（单文档） | `.../wiki/B0K3wFNciiwwMwk9K4lcLhXUndn` | `B0K3wFNciiwwMwk9K4lcLhXUndn` |
| QA 经验文件夹（含子节点） | `.../wiki/Ug8RwLT93iJjM4kR32HcpnBpnuh` | `Ug8RwLT93iJjM4kR32HcpnBpnuh` |

## 已确认的现状

- n8n 实例 `https://n8n.devops.moego.pet`，`n8n-cli` 已认证可用（`credential list` 被 403，但 workflow CRUD 正常）
- 飞书凭证 `JtPRQHOwJYD5CYex`（Feishu User OAuth2 v3 offline_access）
- 已有 **Lark Docs MCP Server**（`meWG3pIV3pDAmyee`，path `lark-mcp`）挂 2 个 tool：
  - `lark_doc_read` → workflow `lark-doc-read`（`QzCdkJGyNNqhk0kG`）
  - `lark_doc_search` → workflow `lark-doc-search`（`HHSaUHDFgaEVpL8M`）
- **关键发现 1**：`lark-doc-read` 已经能处理 wiki token —— 先 `get_node` 拿 `obj_token`，失败则回退当
  普通 docx token 用（`onError: continueRegularOutput`）。200 行 block→markdown 转换已验证可用。
- **关键发现 2**：`lark_doc_search` 走飞书全局搜索 `suite/docs-api/search/object`，**无法按文件夹收窄**。
  这正是必须新建 workflow 的原因。
- 仓库约定：一 tool 一 workflow，JSON 放 `n8n-workflows/<组>/`，大 Code node 抽成 `.js` 用
  PLACEHOLDER 替换，`deploy-*.js` 脚本批量部署。

## 设计决策（已与你确认）

| 项 | 决策 |
|---|---|
| 工具形态 | 3 个独立 tool：`qa_experience_list` / `qa_experience_read` / `qa_checklist_get` |
| 检索策略 | **不做打分、不做 query 排序**。当文件系统用，只 list node + title |
| 目录层级 | 逐层 `ls`，靠 `parent` 参数下钻（非递归全拉） |
| 挂载位置 | **新建** QA Memory MCP Server，与通用 Lark Docs MCP 解耦 |
| 清单角色 | 独立 tool 单独取，不塞进 list 响应 |

## 架构

```
MCP Consumer (QA Agent)
        │ MCP over HTTP
        ▼
┌──────────────────────────────────────────────────────────┐
│ QA Memory MCP Server        [新建]  path: qa-memory-mcp   │
│                                                          │
│  tool: qa_experience_list  ──▶ workflow qa_experience_list│
│         (parent?, page_token?)         [新建]             │
│                                                          │
│  tool: qa_experience_read  ──▶ workflow lark-doc-read     │
│         (token)                        [复用 已存在]      │
│                                                          │
│  tool: qa_checklist_get    ──▶ workflow lark-doc-read     │
│         (无参, token 写死)             [复用 已存在]      │
└──────────────────────────────────────────────────────────┘
        │ HTTPS + OAuth user_access_token
        ▼
   飞书开放平台 wiki / docx API
```

**只需新建 2 个 workflow**，因为：

- `qa_experience_read` 的正文读取逻辑与 `lark-doc-read` **完全一致**（wiki token → `obj_token` →
  blocks → markdown）。MCP tool 节点直接指向已验证的 `QzCdkJGyNNqhk0kG`，不复制那 200 行转换代码。
- `qa_checklist_get` 同理，只是把 tool 节点的 `document_id` 从 `$fromAI(...)` 换成**写死的常量**
  `B0K3wFNciiwwMwk9K4lcLhXUndn`，连参数都不用暴露给 agent。

对 consumer 而言新 server 依然自成闭环：只连 `qa-memory-mcp` 一个 endpoint 就能 ls + cat + 取清单。

> 代价：若日后 QA 场景需要不同的读取行为（比如剥掉图片、加 frontmatter），届时再 fork 一份
> `qa_experience_read` workflow。现在没有这个需求，不提前分叉。

## 新 workflow 1：`qa_experience_list`

唯一真正新增的逻辑。

**输入**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `parent` | string | 否 | 要列的节点 `node_token`。留空 = 列 QA 经验文件夹根目录 |
| `page_token` | string | 否 | 翻页游标，从上次响应的 `next_page_token` 取 |

**节点链**

```
Execute Workflow Trigger (parent?, page_token?)
  → Code「Resolve Target」   target = parent || ROOT_TOKEN
  → HTTP「Get Node」         GET wiki/v2/spaces/get_node?token={target}
  → HTTP「List Children」    GET wiki/v2/spaces/{space_id}/nodes
                                 ?parent_node_token={node_token}
                                 &page_size=50&page_token={page_token}
  → Code「Format」           整形输出
```

`get_node` 对根节点和任意子节点行为一致（都返回 `space_id` + `node_token`），所以**一条代码路径**
同时覆盖「列根目录」和「下钻子目录」。

**输出**

```json
{
  "parent": { "title": "QA 经验", "node_token": "Ug8Rw...", "path_hint": "/" },
  "items": [
    { "title": "支付",         "node_token": "Xa1...", "obj_type": "docx", "is_folder": true  },
    { "title": "退款场景踩坑", "node_token": "Xb2...", "obj_type": "docx", "is_folder": false,
      "url": "https://mengshikeji.feishu.cn/wiki/Xb2..." }
  ],
  "has_more": false,
  "next_page_token": ""
}
```

- `is_folder` 由飞书的 `has_child` 推导 —— agent 靠它决定「继续 ls」还是「cat」
- 叶子节点也可能有子节点（飞书 wiki 任意节点都能挂子节点），所以 `is_folder` 是提示而非互斥标记
- 目标节点无子节点时 `items: []`，并在 `parent` 里带 `hint` 提示「这是文档，请用
  `qa_experience_read` 读正文」

**分页取舍**：飞书 `nodes` 接口 `page_size` 上限 50。仓库里没有现成的 n8n 隐式分页写法，
`ms_list_modules` 的先例是把 offset/limit 显式暴露。这里同样**显式暴露 `page_token`**，
不在 HTTP 节点里配隐式分页 —— 单层目录超过 50 个子节点属少见情况，且 `has_more` 会明确告知 agent。

**ROOT_TOKEN 写死**在「Resolve Target」Code 节点顶部的常量里（`ms_list_modules` 也是把
projectId/accessKey 直接写在 Code 节点内，与仓库现状一致），加注释说明改这里即可换文件夹。

## 新 workflow 2：`QA Memory MCP Server`

MCP Trigger（`@n8n/n8n-nodes-langchain.mcpTrigger` typeVersion 2）+ 3 个 `toolWorkflow` 节点。
`authentication: n8nOAuth2`、`path: qa-memory-mcp`、`settings.availableInMCP: true` —— 与
Figma / Lark Docs MCP Server 保持一致。

三个 tool 的 description 直接决定 agent 会不会用对，按仓库现有风格写得足够啰嗦：

| tool | 指向 workflow | 输入映射 |
|---|---|---|
| `qa_experience_list` | `qa_experience_list`（新建） | `parent`/`page_token` ← `$fromAI(...)` |
| `qa_experience_read` | `lark-doc-read`（`QzCdkJGyNNqhk0kG`） | `document_id` ← `$fromAI('token', ...)` |
| `qa_checklist_get` | `lark-doc-read`（`QzCdkJGyNNqhk0kG`） | `document_id` = 写死常量，不暴露参数 |

description 里会明确写清用法顺序：先 `qa_experience_list` 拿目录 → `is_folder: true` 就带 `parent`
再 list → `is_folder: false` 就把 `node_token` 交给 `qa_experience_read` 读正文；写用例前**先调
`qa_checklist_get`** 拿通用测试维度。

## 文件落位

```
n8n-workflows/qa-memory/
├── qa_experience_list.json          # workflow 定义（PLACEHOLDER_FORMAT）
├── qa_experience_list-format.js     # Format 节点代码
├── qa_memory_mcp_server.json        # MCP Server 定义
└── deploy-qa-memory-workflows.js    # 部署脚本，照搬 deploy-figma-workflows.js
```

`.claude/plans/qa-memory-mcp-tools.md` 即本文件。

## 验证步骤

1. `node n8n-workflows/qa-memory/deploy-qa-memory-workflows.js` 创建两个 workflow
2. **实测目录结构**：`executeWorkflowTrigger` 无法用 CLI 直接触发，所以临时给
   `qa_experience_list` 加一个 webhook trigger，`curl` 打一次拿到真实的文件夹层级和字段，
   核对 `has_child` / `obj_type` / 中文标题编码，**验证完立刻删掉 webhook 节点并重新部署**
   - ⚠️ 这一步会在内网域名上短暂开一个无鉴权的只读 endpoint（随机 path）。只读、分钟级、用完即删。
     如果你不接受，我改成由你在 n8n UI 里手点一次 execute，我读 `n8n-cli execution get` 的结果
3. 用真实层级校对输出整形逻辑（特别是根目录直接挂文档、以及子文件夹嵌套两种情况）
4. `n8n-cli workflow activate` 激活两个 workflow
5. 你在 MCP client 里连 `https://n8n.devops.moego.pet/mcp/qa-memory-mcp`，实测三个 tool

## 风险 & 取舍

| 风险 | 缓解 |
|---|---|
| 经验文件夹实际层级未知（我尚未实测） | 验证步骤 2 拿到真实结构后再定型整形逻辑；逐层 ls 的设计对任意深度都成立 |
| 单层子节点 > 50 | 显式暴露 `page_token` + `has_more`，agent 可续拉 |
| OAuth token 过期 | 沿用已在跑的 `JtPRQHOwJYD5CYex`（带 offline_access），与现有 lark workflow 同一套 |
| 复用 `lark-doc-read` 造成耦合 | 改动它会同时影响 Lark Docs MCP。若日后需要 QA 专属读取行为，届时 fork |
| agent 不调 `qa_checklist_get` 就写用例 | 靠 tool description 强提示；若实测仍漏，再考虑把清单并入 list 响应 |

## 明确不做

- **不做打分 / 语义检索 / embedding** —— 按你的决定，纯文件系统语义
- **不做缓存 / 落库 / 定时同步** —— 每次实时读飞书，真人加文档即生效，这才是「简单记忆机制」
- ~~**不改动**现有 `lark-doc-read`~~ —— **2026-08-03 已推翻**：实测发现 `lark-doc-read` 只拉一页
  （`page_size=500` 无翻页），616 block 的检查清单被静默截断掉 116 个 block（整个「十四、安全」和
  「十五、用户体验一致性」两节全丢）。经确认后按选项 A 修了翻页 + `onError`，两个 MCP Server 同时受益。
  详见本文件末尾「2026-08-03 修复记录」
- **不改动** `lark-doc-search` / Lark Docs MCP Server 本身
- 标题子串过滤（`keyword` 参数）是后续想加就能加的一行改动，本次不加

---

## 2026-08-03 实测与修复记录

三个 tool 全部实测通过（MCP 真实调用，非 mock）：

| 场景 | 结果 |
|---|---|
| `qa_experience_list` 列根目录 | ✓ 2 个子节点，`has_child` → `is_folder` 推导正确，中文标题正常 |
| `qa_experience_list` 下钻叶子 | ✓ `items: []` + 正确给出改用 read 的 hint |
| `qa_experience_list` 坏 token | ✓ 干净错误对象，带飞书 code `131005` |
| `qa_experience_read` 读文档 | ✓ wiki `node_token` → docx `obj_token` 解析正确 |
| `qa_checklist_get` | ✓ 修复后完整返回 616 block |

字段形状与设计假设一致，整形逻辑未作调整。

### 修的 bug：`lark-doc-read` 分页截断

`Fetch Blocks` 用 `?page_size=500` 拉一次就结束，拿到 `page_token` 却丢弃。执行日志实证：

```
修复前：has_more: true, 返回 500 block, markdown 3682 字符 → 后 116 block 静默丢失
修复后：第1页 500 block (has_more: true) + 第2页 116 block → 合并 616, markdown 4540 字符
```

丢的正是「十四、安全」「十五、用户体验一致性」两整节 + 使用说明。一份检查清单被砍掉后半截而不
报错，agent 会拿着残表当完整的用 —— 这是最坏的失败模式。

改动（`n8n-workflows/deploy-lark-doc-read.js` 组装部署）：

- `Fetch Blocks` 加 n8n 分页（`page_token` / `has_more`，`maxRequests: 20` 即上限约 1 万 block）
  + `neverError` + `onError: continueRegularOutput`
- `Blocks to Markdown` 从 `$input.first()` 改为合并 `$input.all()`；新增飞书错误分支；
  撞到 `maxRequests` 上限时在正文追加 ⚠️ 警告并置 `truncated: true`
- 输出新增 `block_count` / `page_count` / `truncated` 三个可观测字段
- 转换器主体（58 行）从线上逐字节提取后原样保留，未改一字，降低回归风险

顺带修好：坏 token 从 raw `Bad request - please check your parameters` 变成带飞书 code 的可操作提示。

代码拆成 `lark-doc-read-head.js` + `-converter.js` + `-tail.js` 三段，便于日后改取数逻辑而不碰转换器。
回归测试 `test-lark-doc-read.mjs`（37 断言）覆盖单页回归、多页合并、撞上限告警、业务错误、HTTP 异常、
富文本转换未破坏。

### 仍未做

- **表格仍退化成 `[表格: 6×3]` + 单元格平铺**，行列对应关系丢失。清单几乎全是三列表格，agent 有串行
  风险。这是独立的一档改动（要处理嵌套表格、合并单元格的降级），建议单独一轮做
- `n8n-workflows/lark-doc-read-code.js` 是过时副本（引用了已不存在的节点名
  `Execute Workflow Trigger`，照它部署会直接搞坏 workflow），**应删除**，已被上述三段文件取代
