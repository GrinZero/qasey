# Plan: MeterSphere MCP Tools (n8n)

## 目标

在 n8n 上构建一组 MCP Tools，接入公司自部署 MeterSphere v2.10 实例（`https://metersphere.devops.moego.pet`），支持查询和写入测试管理数据。

## 需求确认

| 项 | 决策 |
|---|---|
| 暴露方式 | n8n MCP Server（workflow 即 tool） |
| MeterSphere 版本 | v2.10.24-lts |
| 认证方式 | AES-128-CBC 签名（AccessKey + SecretKey） |
| 基地址 | `https://metersphere.devops.moego.pet` |
| API 前缀 | **已验证**: 统一 `/track/` 前缀（api-test 模块网关未暴露） |
| 返回格式 | JSON → 结构化 MCP 响应 |
| MCP 消费方 | Claude / Agent / etc. |

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
│  Workflow 1: ms_list_projects               │
│  Workflow 2: ms_list_modules                │
│  Workflow 3: ms_list_test_cases             │
│  Workflow 4: ms_get_test_case_detail        │
│  Workflow 5: ms_list_case_reviews           │
│  Workflow 6: ms_get_review_detail           │
│  Workflow 7: ms_create_test_case            │
│  Workflow 8: ms_create_module               │
│  (共用 Code node: AES 签名生成)              │
└──────────────┬──────────────────────────────┘
               │ HTTPS (AES-128-CBC signature)
               ▼
┌─────────────────────────────────────────────┐
│  MeterSphere v2.10.24-lts (self-hosted)     │
│  https://metersphere.devops.moego.pet       │
└─────────────────────────────────────────────┘
```

---

## 认证方案（已验证 ✅）

MeterSphere v2 使用 AES-128-CBC 签名认证：

1. 构造复合串: `accessKey + "|" + uuid4 + "|" + timestamp_ms`
2. AES-128-CBC 加密：**SecretKey 前 16 字节**为密钥，**AccessKey 前 16 字节**为 IV
3. Base64 编码得到 signature
4. 请求头: `accessKey: <key>`, `signature: <encrypted_str>`, `Content-Type: application/json`, `ACCEPT: application/json`

```javascript
// 已验证可用的签名代码
const crypto = require('crypto');

const accessKey = 'yCrnfHeNp7sKC5h3';
const secretKey = 'Em2sPDj0VaRGvnnY';

const timestamp = Date.now();
const uuid = crypto.randomUUID();
const comboxKey = `${accessKey}|${uuid}|${timestamp}`;

const key = Buffer.from(secretKey.slice(0, 16), 'utf-8');
const iv = Buffer.from(accessKey.slice(0, 16), 'utf-8');
const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);

let encrypted = cipher.update(comboxKey, 'utf-8', 'base64');
encrypted += cipher.final('base64');
// encrypted 即为 signature
```

---

## 已验证 API 清单

### ✅ 已验通接口

| # | 接口 | 方法 | 路径 | Body 示例 |
|---|------|------|------|-----------|
| 1 | 工作空间列表 | GET | `/track/workspace/list/userworkspace` | — |
| 2 | 项目列表 | POST | `/track/project/list/related` | `{workspaceId}` |
| 3 | 模块树 | GET | `/track/case/node/list/{projectId}` | — |
| 4 | 用例列表（分页） | POST | `/track/test/case/list/{page}/{size}` | `{projectId, name?, nodeId?}` |
| 5 | 用例详情 | GET | `/track/test/case/get/{caseId}` | — (返回含 `issueList` 字段) |
| 6 | 创建用例 | POST | `/track/test/case/save` | JSON body (非 multipart) |
| 7 | 删除用例 | POST | `/track/test/case/deleteToGc/{caseId}` | — |
| 8 | 评审单列表 | POST | `/track/test/case/review/list/{page}/{size}` | `{projectId}` |
| 9 | 评审详情 | GET | `/track/test/case/review/get/{reviewId}` | — |
| 10 | 评审人列表 | POST | `/track/test/case/review/reviewer` | `{id: reviewId}` |
| 11 | 评审下的用例 | POST | `/track/test/review/case/list/{page}/{size}` | `{reviewId}` |
| 12 | 用例评审记录 | POST | `/track/test/case/reviews/case/{page}/{size}` | `{projectId, id: caseId}` |
| 13 | 缺陷列表（项目级） | POST | `/track/issues/list/{page}/{size}` | `{projectId}` |

### ❌ 不可用接口

| 接口 | 原因 |
|------|------|
| API 定义 (`/api/definition/...`) | 网关未暴露该模块路由 |
| 用例关联缺陷（单独查） | `issueList` 已内嵌在用例详情中，无需单独接口 |
| `GET /track/issues/get/case/{refType}/{id}` | 500 错误（依赖第三方平台连接） |

### 关键数据点

- **唯一工作空间**: `20a7019f-19aa-11ee-a261-5a66b98c4036` (默认工作空间)
- **唯一项目**: `20a78db9-19aa-11ee-a261-5a66b98c4036` (Amazing Product)
- **默认版本 ID**: `3570d801-19aa-11ee-a261-5a66b98c4036`

---

## Tool 清单与 API 映射

### Tool 1: `ms_list_projects` — 查询项目列表

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| workspace_id | string | 否 | 工作空间 ID（默认取唯一工作空间） |

**API**: `POST /track/project/list/related`  
**Body**: `{ "workspaceId": "<id>" }`

---

### Tool 2: `ms_list_modules` — 查询模块树

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| project_id | string | 是 | 项目 ID |

**API**: `GET /track/case/node/list/{projectId}`  
**返回**: 树形结构 `[{id, name, parentId, level, children: [...]}]`

---

### Tool 3: `ms_list_test_cases` — 分页查询功能用例

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| project_id | string | 是 | 项目 ID |
| page | number | 否 | 页码，默认 1 |
| page_size | number | 否 | 每页数量，默认 20 |
| name | string | 否 | 用例名称模糊搜索 |
| node_id | string | 否 | 模块 ID 过滤 |

**API**: `POST /track/test/case/list/{page}/{pageSize}`  
**Body**: `{ "projectId": "<id>", "name": "<keyword>", "nodeId": "<moduleId>" }`  
**返回**: `{ listObject: [...], itemCount, pageCount }`

---

### Tool 4: `ms_get_test_case_detail` — 查询用例详情

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| case_id | string | 是 | 用例 ID |

**API**: `GET /track/test/case/get/{caseId}`  
**返回字段**: id, name, nodePath, priority, type, maintainer, status, reviewStatus, stepModel, stepDescription, expectedResult, prerequisite, tags, **issueList** (关联缺陷), customFields 等

> 注: `issueList` 已内嵌在详情返回中，不需要额外请求缺陷接口。

---

### Tool 5: `ms_list_case_reviews` — 分页查询评审单

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| project_id | string | 是 | 项目 ID |
| page | number | 否 | 页码，默认 1 |
| page_size | number | 否 | 每页数量，默认 20 |

**API**: `POST /track/test/case/review/list/{page}/{pageSize}`  
**Body**: `{ "projectId": "<id>" }`  
**返回**: 含 name, status, passRate, caseCount, reviewers, statusCountItems 等

---

### Tool 6: `ms_get_review_detail` — 查询评审详情（含评审人 + 用例列表）

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| review_id | string | 是 | 评审 ID |
| page | number | 否 | 用例列表页码，默认 1 |
| page_size | number | 否 | 用例列表每页数量，默认 20 |

**API 调用组合**:
1. `GET /track/test/case/review/get/{reviewId}` — 评审基本信息
2. `POST /track/test/case/review/reviewer` body `{id: reviewId}` — 评审人列表
3. `POST /track/test/review/case/list/{page}/{size}` body `{reviewId}` — 评审下用例

---

### Tool 7: `ms_create_test_case` — 创建功能用例

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| project_id | string | 是 | 项目 ID |
| name | string | 是 | 用例名称 |
| node_id | string | 否 | 模块 ID（默认"未规划用例"） |
| priority | string | 否 | P0/P1/P2/P3，默认 P2 |
| type | string | 否 | functional/performance/api，默认 functional |
| maintainer | string | 否 | 责任人邮箱 |
| prerequisite | string | 否 | 前置条件 |
| step_model | string | 否 | TEXT 或 STEP，默认 TEXT |
| step_description | string | 否 | 步骤描述（TEXT 模式） |
| expected_result | string | 否 | 预期结果（TEXT 模式） |
| steps | string | 否 | 步骤 JSON（STEP 模式: `[{num,desc,result}]`） |
| tags | string | 否 | 标签 JSON 数组，如 `["tag1","tag2"]` |

**API**: `POST /track/test/case/save`  
**Body** (JSON，非 multipart):
```json
{
  "id": "<uuid>",
  "projectId": "<project_id>",
  "name": "<name>",
  "nodeId": "<node_id>",
  "nodePath": "<从模块树获取>",
  "type": "functional",
  "priority": "P2",
  "method": "manual",
  "maintainer": "<email>",
  "prerequisite": "<前置条件>",
  "stepModel": "TEXT",
  "stepDescription": "<步骤>",
  "expectedResult": "<预期结果>",
  "tags": "[]",
  "status": "Prepare",
  "reviewStatus": "Prepare",
  "versionId": "3570d801-19aa-11ee-a261-5a66b98c4036",
  "refId": "<same as id>",
  "latest": true
}
```

---

## 实施步骤

### Phase 1: n8n Credential 配置

在 n8n 中配置 MeterSphere 的 AK/SK。推荐方式：
- 使用 n8n 的 Code node 内置环境变量，或直接在 workflow 中硬编码（内网环境可接受）

### Phase 2: 逐个构建 Workflow

每个 workflow 结构：
```
Execute Workflow Trigger → Code (签名) → HTTP Request → Code (格式化输出)
```

实施顺序：
1. `ms_list_projects` (最简单，验证签名)
2. `ms_list_modules`
3. `ms_list_test_cases`
4. `ms_get_test_case_detail`
5. `ms_list_case_reviews`
6. `ms_get_review_detail`
7. `ms_create_test_case`

### Phase 3: 验证 & 发布

1. 每个 workflow 用 n8n test execution 验证
2. 激活所有 workflow，确认 MCP access 开启
3. 从 MCP client 端联调

---

### Tool 8: `ms_create_module` — 创建模块（子文件夹）

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 模块名称 |
| parent_id | string | 否 | 父模块 ID（不传则创建顶层模块） |

**API**: `POST /track/case/node/add`  
**Body**:
```json
{
  "id": "<uuid>",
  "projectId": "<project_id>",
  "name": "<模块名称>",
  "parentId": "<父模块ID或null>"
}
```
**返回**: 新建模块的 id、name、parent_id

> 使用场景：先调 `ms_list_modules` 查看现有模块树，拿到目标父模块的 id，再调此 tool 创建子文件夹。

---

## 已排除的功能

| 功能 | 排除原因 |
|------|----------|
| 接口定义查询 | api-test 模块网关未暴露 |
| 接口用例查询 | 同上 |
| 用例关联缺陷（独立查） | 用例详情 API 已内嵌 `issueList`，无需单独接口 |

---

## 下一步

所有接口已验证通过，可以开始构建 n8n workflow。
