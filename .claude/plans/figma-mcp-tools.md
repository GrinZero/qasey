# Figma MCP Tools — n8n Workflow 实现计划

## 目标

基于 Figma REST API 设计一组 n8n workflow，包装为 MCP tools，供 QA Agent 在设计测试用例时引用 Figma 设计稿。

## 设计原则

1. **分层访问** — 从轻量概览到细节 drill-down，避免一次返回过大
2. **预处理 + 可选代码过滤** — n8n 侧先做结构化精简，agent 可传入 JS/jmespath 表达式做二次过滤
3. **沙箱安全** — 代码执行有超时和作用域限制

---

## 预处理后的标准化节点结构（`FigmaNode`）

所有 tool 返回的节点数据统一为此结构，也是 `filter_code` 操作的输入：

```typescript
interface FigmaNode {
  id: string
  name: string
  type: string                    // FRAME, COMPONENT, TEXT, INSTANCE, GROUP, etc.
  visible: boolean
  // 文本节点专属
  characters?: string             // 文本内容
  // 组件/实例专属
  component_name?: string         // 来源组件名
  variants?: Record<string, string>  // variant 属性键值对（如 {state: "error", size: "md"}）
  // 结构
  children_count?: number         // 子节点数量（不展开时用）
  children?: FigmaNode[]          // 展开的子节点
  // 布局摘要（可选）
  layout?: {
    width: number
    height: number
    layout_mode?: string          // HORIZONTAL, VERTICAL, NONE
  }
}
```

---

## Workflow 列表

### 1. `figma_list_pages`

**用途**：列出文件所有页面，极轻量入口

| 字段 | 说明 |
|------|------|
| Figma API | `GET /v1/files/:key?depth=1` |
| 入参 | `file_key` |
| 预处理 | 只提取 document.children（即 pages），返回 `{id, name}[]` |
| 输出上限 | 无需（页面数量一般 < 50） |

---

### 2. `figma_get_page_structure`

**用途**：返回某页面的结构摘要，用于了解有哪些界面/组件

| 字段 | 说明 |
|------|------|
| Figma API | `GET /v1/files/:key/nodes?ids=<page_id>&depth=<depth>` |
| 入参 | `file_key`, `page_id`, `depth?`(默认 2), `text_only?`, `filter_code?` |
| 预处理 | 递归遍历到 depth，转为 `FigmaNode[]`；如 `text_only=true` 则只保留 TEXT 类型节点 |
| 过滤 | 如有 `filter_code`，在 Code node 沙箱中执行（输入变量 `nodes`） |
| 输出上限 | 结果 > 200 节点时，截断并返回 `has_more: true`, `total_count` |

---

### 3. `figma_get_node_detail`

**用途**：获取单个/少量节点的完整属性（agent 按需 drill-down）

| 字段 | 说明 |
|------|------|
| Figma API | `GET /v1/files/:key/nodes?ids=<node_ids>` |
| 入参 | `file_key`, `node_ids`(最多 10 个), `include_styles?`, `filter_code?` |
| 预处理 | 转为完整 `FigmaNode`（含 children 全展开）；如 `include_styles=false` 则剥离样式信息 |
| 过滤 | 同上 |
| 输出上限 | 单节点深度 > 5 层时警告 |

---

### 4. `figma_get_components`

**用途**：列出文件中所有组件及其 variant 信息，对 QA 特别有用（了解控件状态）

| 字段 | 说明 |
|------|------|
| Figma API | `GET /v1/files/:key/components` + `GET /v1/files/:key/component_sets` |
| 入参 | `file_key`, `filter_code?` |
| 预处理 | 合并 components 和 component_sets，提取 `{name, description, variants, thumbnail_url, node_id}` |
| 过滤 | 同上，变量名 `components` |
| 输出上限 | 默认最多 100 条 |

---

### 5. `figma_export_image`

**用途**：导出指定节点为截图 URL

| 字段 | 说明 |
|------|------|
| Figma API | `GET /v1/images/:key?ids=<node_ids>&format=png&scale=2` |
| 入参 | `file_key`, `node_ids`(最多 5 个), `format?`(png/svg/pdf), `scale?`(默认 2) |
| 预处理 | 直接返回 `{node_id, image_url}[]`，无需过滤 |
| 注意 | URL 30 天过期 |

---

### 6. `figma_get_comments`

**用途**：获取设计稿上的评审备注（可能包含交互说明、edge case）

| 字段 | 说明 |
|------|------|
| Figma API | `GET /v1/files/:key/comments?as_md=true` |
| 入参 | `file_key`, `filter_code?` |
| 预处理 | 提取 `{id, message, user_name, created_at, resolved, node_id?, parent_id?}[]` |
| 过滤 | 同上，变量名 `comments` |
| 输出上限 | 默认最多 50 条 |

---

### 7. `figma_query_nodes`

**用途**：高级查询——agent 传入过滤表达式，对整棵树做筛选

| 字段 | 说明 |
|------|------|
| Figma API | `GET /v1/files/:key?depth=<max_depth>` |
| 入参 | `file_key`, `max_depth?`(默认 5), `filter_code`(**必填**) |
| 预处理 | 全树 flatten 为 `FigmaNode[]`（带 `parent_id` 字段） |
| 过滤 | 执行 `filter_code`，返回匹配节点 |
| 输出上限 | 最多 200 条，超出返回 `has_more` + `total_matched` |

---

## 代码过滤沙箱规范（适用于所有 workflow 的 Code node）

```javascript
/**
 * n8n Code Node — 沙箱执行 agent 传入的过滤代码
 * 
 * 输入: 
 *   - data: 预处理后的节点数组（来自上游 Code node）
 *   - filter_code: agent 传入的表达式字符串
 *   - filter_lang: 'js' | 'jmespath' | 'jsonpath'
 * 
 * 规则:
 *   - 超时: 3s
 *   - 禁止: require, import, fetch, process, global 访问
 *   - 输入变量: nodes（或 components/comments，取决于 tool）
 *   - 返回值: 必须是数组
 *   - 错误: 直接返回 { error: message } 给 agent
 */
```

**JS 模式执行方式（n8n Code node 内置环境，无需额外 npm 包）：**
```javascript
const sandbox = { nodes: data };
const script = new Function('nodes', filter_code);
const result = script(sandbox.nodes);
// 校验返回值必须是数组
if (!Array.isArray(result)) throw new Error('filter_code must return an array');
return result;
```

注：n8n Code node 无法安装额外 npm 包，因此只支持 `filter_lang: 'js'`。
JMESPath/JSONPath 不可用——agent 用原生 JS 数组方法（filter/map/find/some）覆盖所有过滤需求。

---

## n8n Workflow 通用结构

每个 workflow 遵循相同的 4 节点模式：

```
[Trigger] → [HTTP: Figma API] → [Code: 预处理] → [Code: 可选过滤] → [Output]
```

- **Trigger**: `executeWorkflowTrigger`，定义入参 schema
- **HTTP**: 调用 Figma API（使用 Header Auth credential：`X-Figma-Token`）
- **Code 1（预处理）**: 将原始响应转为标准化 `FigmaNode[]`
- **Code 2（过滤）**: 如果 `filter_code` 非空，在沙箱中执行；否则 passthrough
- **Output**: 拼装最终响应 + 截断/分页逻辑

---

## 认证方式

- 使用 n8n 内置的 `Figma OAuth2 API` credential（已创建："Figma account"）
- HTTP Request node 配置：`authentication: "predefinedCredentialType"`, `nodeCredentialType: "figmaOAuth2Api"`
- n8n 自动处理 token refresh，无需手动管理
- 所需 scope: `file_content:read`, `file_comments:read`, `library_content:read`

---

## Rate Limit 应对

- Figma API 有 Tier 1/2/3 的 rate limit（具体配额未公开，但建议保守使用）
- n8n 侧可加 Cache node（TTL 5min），对同一 file_key + params 的请求做缓存
- `figma_export_image` 返回的 URL 30 天有效，可缓存更长

---

## 实施顺序

1. **Phase 1**: `figma_list_pages` + `figma_get_page_structure` — 最基础的浏览能力
2. **Phase 2**: `figma_get_node_detail` + `figma_export_image` — drill-down 和截图
3. **Phase 3**: `figma_get_components` — 组件/状态枚举
4. **Phase 4**: `figma_get_comments` + `figma_query_nodes` — 高级查询

---

## QA Agent 使用流程示例

```
1. figma_list_pages(file_key) 
   → 看到 "Settings Page", "Dashboard", "Login Flow" 等页面

2. figma_get_page_structure(file_key, page_id="Login Flow", depth=2)
   → 看到 Frame: "Login Form" 包含 Input: "Email", Input: "Password", Button: "Sign In"

3. figma_get_components(file_key, filter_code="components.filter(c => c.name.includes('Button'))")
   → 看到 Button 有 variant: {state: default/hover/disabled/loading, size: sm/md/lg}

4. figma_get_node_detail(file_key, node_ids=["Login Form 的 id"])
   → 获取完整表单结构：字段名、placeholder、validation 提示文本

5. figma_get_comments(file_key, filter_code="comments.filter(c => !c.resolved)")
   → 看到设计师备注："密码错误超过3次需锁定账户"

→ QA Agent 据此生成测试用例：正常登录、空字段校验、密码锁定、各按钮状态...
```

---

## Branch 支持

所有 tool 的 `file_key` 参数同时接受主文件 key 和 branch key（Figma API 本身兼容）。无需额外参数区分——agent 传哪个 key 就读哪个版本。

如果需要列出某文件的所有 branch，可通过 `GET /v1/files/:key?branch_data=true` 获取，后续按需新增 `figma_list_branches` tool。

---

## 待确认项

- [ ] 输出 token 预算控制——是否需要像 RAG 一样算 token 数做硬截断，还是节点条数上限够用
