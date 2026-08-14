import crypto from 'node:crypto';
import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected MeterSphere MCP workflow JSON on stdin');

const workflow = JSON.parse(input);
const trigger = workflow.nodes.find((node) => node.type === '@n8n/n8n-nodes-langchain.mcpTrigger');
if (!trigger) throw new Error('MCP Server Trigger node was not found');

function schemaField(id, displayName, type, required) {
  return {
    id,
    displayName,
    required,
    defaultMatch: false,
    display: true,
    canBeUsedToMatch: true,
    type,
    removed: false,
  };
}

function upsertTool({ name, workflowId, position, description, value, schema }) {
  let tool = workflow.nodes.find((node) => node.name === name);
  const parameters = {
    description,
    workflowId: {
      __rl: true,
      value: workflowId,
      mode: 'list',
      cachedResultUrl: '/workflow/' + workflowId,
      cachedResultName: name,
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value,
      matchingColumns: [],
      schema,
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    },
  };
  if (tool) {
    tool.parameters = parameters;
    tool.type = '@n8n/n8n-nodes-langchain.toolWorkflow';
    tool.typeVersion = 2.2;
    tool.position = position;
  } else {
    tool = {
      id: crypto.randomUUID(),
      name,
      type: '@n8n/n8n-nodes-langchain.toolWorkflow',
      typeVersion: 2.2,
      parameters,
      position,
    };
    workflow.nodes.push(tool);
  }
  workflow.connections[name] = {
    ai_tool: [[{ node: trigger.name, type: 'ai_tool', index: 0 }]],
  };
}

upsertTool({
  name: 'ms_batch_edit_test_cases',
  workflowId: 'ao2haqUFIYkfXw1y',
  position: [464, 48],
  description: `对一组明确指定的 MeterSphere 功能测试用例应用同一项修改，并逐条回查验证结果。

安全限制：
- 只能传显式 case_ids，禁止 selectAll 或筛选条件批量命中；每次最多 50 条，UUID 会校验并去重。
- field 仅允许 priority、status、maintainer、tags。
- priority 只能是 P0/P1/P2/P3；maintainer 必须是账号邮箱；tags 的 value 必须是 JSON 数组字符串。
- 修改 tags 时 tag_mode 只能是 replace 或 append，其他字段忽略 tag_mode。
- dry_run=true 时只进行参数与用例归属预检，不写入。

推荐先用 ms_list_test_cases 或 ms_get_test_case_detail 确认 case UUID。示例：
{"case_ids":"[\"97bb25db-18df-428e-af86-be305ad8b2ff\"]","field":"priority","value":"P1","dry_run":false}

标签示例：
{"case_ids":"[\"97bb25db-18df-428e-af86-be305ad8b2ff\"]","field":"tags","value":"[\"回归\",\"P1\"]","tag_mode":"append","dry_run":false}`,
  value: {
    case_ids: "={{ $fromAI('case_ids', '必填，JSON 数组字符串，包含 1-50 个明确的功能用例 UUID。禁止 selectAll。示例：[\"97bb25db-18df-428e-af86-be305ad8b2ff\"]', 'string') }}",
    field: "={{ $fromAI('field', '必填，只能是 priority、status、maintainer、tags 之一。', 'string') }}",
    value: "={{ $fromAI('value', '必填。priority/status/maintainer 传字符串；tags 传 JSON 数组字符串，例如 [\"回归\",\"P1\"]。', 'string') }}",
    tag_mode: "={{ $fromAI('tag_mode', '仅 field=tags 时使用，只能是 replace 或 append，默认 replace。', 'string', 'replace') }}",
    dry_run: "={{ $fromAI('dry_run', '可选。true 只预检不写入；false 执行更新。默认 false。', 'boolean', false) }}",
  },
  schema: [
    schemaField('case_ids', 'case_ids（JSON UUID 数组，必填）', 'string', true),
    schemaField('field', 'field（白名单字段，必填）', 'string', true),
    schemaField('value', 'value（必填）', 'string', true),
    schemaField('tag_mode', 'tag_mode（replace/append）', 'string', false),
    schemaField('dry_run', 'dry_run（只预检）', 'boolean', false),
  ],
});

upsertTool({
  name: 'ms_bulk_upsert_test_cases',
  workflowId: 'srg3qjHKTdJUbJ6v',
  position: [592, 48],
  description: `安全封装 MeterSphere /track/test/case/minder/edit，在一次调用中批量创建和更新功能测试用例。

安全限制：
- items 必须是 JSON 数组字符串，每次 1-25 项；每项必须显式 operation=create 或 update。
- 顶层删除 ids 永远由 workflow 强制设置为空数组；不接受模块编辑、脑图扩展节点或任意原始 minder 参数。
- 每项只接受白名单字段；id、ids、isEdit、projectId、testCaseNodes、extraNodeRequest、customFields 等字段都会被拒绝。
- create：必须传 name、node_id、node_path；禁止 case_id。node_id/path 必须来自 ms_list_modules 的同一个叶子模块。
- update：必须传 case_id 和至少一个要修改的字段。移动模块时 node_id 与 node_path 必须成对传；不传则保持原模块。
- update 不支持 tags，因为 MeterSphere minder/edit 会忽略更新标签；统一更新标签请使用 ms_batch_edit_test_cases。
- dry_run=true 时只做参数、模块和已有用例预检，不写入。正式执行后会逐条回查并返回新建/更新的 UUID。

items 每项可用字段：operation、case_id、name、node_id、node_path、priority、maintainer、status、prerequisite、step_model、step_description、expected_result、steps、tags（仅 create）、remark。

示例：
{"items":"[{\"operation\":\"update\",\"case_id\":\"97bb25db-18df-428e-af86-be305ad8b2ff\",\"priority\":\"P1\"},{\"operation\":\"create\",\"name\":\"批量创建示例\",\"node_id\":\"aa79b6a0-6789-4bf7-9b35-dd643a4b9983\",\"node_path\":\"/AI Draft/Minimum Booking Policy V1/01 Pricing Rule 配置\",\"priority\":\"P2\",\"maintainer\":\"jiabowang@moego.pet\",\"steps\":[{\"num\":1,\"desc\":\"操作\",\"result\":\"预期\"}]}]","dry_run":false}`,
  value: {
    items: "={{ $fromAI('items', '必填，JSON 数组字符串，包含 1-25 个 create/update 对象。不要传顶层删除 ids 或原始 minder 字段。', 'string') }}",
    dry_run: "={{ $fromAI('dry_run', '可选。true 只预检不写入；false 执行批量创建/更新。复杂批次建议先 true。默认 false。', 'boolean', false) }}",
  },
  schema: [
    schemaField('items', 'items（JSON 操作数组，必填）', 'string', true),
    schemaField('dry_run', 'dry_run（只预检）', 'boolean', false),
  ],
});

const writableSettings = {};
for (const key of ['executionOrder', 'callerPolicy']) {
  if (workflow.settings && Object.prototype.hasOwnProperty.call(workflow.settings, key)) {
    writableSettings[key] = workflow.settings[key];
  }
}

process.stdout.write(JSON.stringify({
  name: workflow.name,
  nodes: workflow.nodes,
  connections: workflow.connections,
  settings: writableSettings,
}));
