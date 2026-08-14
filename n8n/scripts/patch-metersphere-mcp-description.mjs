import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

const workflow = JSON.parse(input);
const node = (workflow.nodes ?? []).find((candidate) => candidate.name === 'ms_create_test_case');
if (!node) throw new Error('ms_create_test_case tool node was not found');

node.parameters.description = [
  '创建一条新的 MeterSphere 功能测试用例。用于新增，不用于编辑或删除。',
  '调用规则：',
  '- name、node_id、node_path 必填。node_id 和 node_path 必须原样使用 ms_list_modules 返回的同一个目标叶子模块 UUID 与完整 path。',
  '- 嵌套模块必须传最终子文件夹的 id，禁止传父文件夹或同级汇总文件夹的 id。例：目标是 /AI Draft/Minimum Booking Policy V1/01 Pricing Rule 配置，就必须传 01 Pricing Rule 配置 的 id，不能传 Minimum Booking Policy V1 或 Minimum Booking Policy V1 - Detailed Cases 的 id。',
  '- MeterSphere 以 node_id 决定列表归属，nodePath 仅由 workflow 根据 node_id 计算。node_id 传错时，即使名称或路径看起来正确，用例也不会出现在目标子文件夹列表中。',
  '- workflow 会强制校验 node_id 与 node_path 指向同一节点、目标 is_leaf=true、priority 合法；创建后还会调用详情 API 回查 nodeId/nodePath，一致才返回成功。',
  '- 选择步骤：先调用 ms_list_modules；沿完整祖先链定位目标；核对目标节点名称及父节点；最后原样复制该叶子节点 id。不要根据相似名称猜测 UUID。',
  '- 正确示例：01 Pricing Rule 配置 -> aa79b6a0-6789-4bf7-9b35-dd643a4b9983。错误示例：传父目录 Minimum Booking Policy V1 的 id，或传同级 Minimum Booking Policy V1 - Detailed Cases 的 id。',
  '- priority 只能是 P0、P1、P2、P3；maintainer 传 MeterSphere 账号标识（当前默认 jiabowang@moego.pet）。',
  '- tags 必须是 JSON 数组字符串，例如：["FIN-7119","P2","回归"]。禁止传 FIN-7119,P2,回归 这种逗号字符串。',
  '- steps 必须是 JSON 数组字符串，例如：[{"num":1,"desc":"打开页面","result":"页面正常展示"}]。每项使用 num、desc、result；step id 由 workflow 自动补齐。',
  '- step_model 推荐 STEP。prerequisite、step_description、expected_result 没有内容时传空字符串。',
  '完整示例：',
  '{"name":"Pricing rule 配置权限与越权拦截","node_id":"aa79b6a0-6789-4bf7-9b35-dd643a4b9983","node_path":"/AI Draft/Minimum Booking Policy V1/01 Pricing Rule 配置","priority":"P1","maintainer":"jiabowang@moego.pet","prerequisite":"准备有权限和无权限账号","step_model":"STEP","step_description":"","expected_result":"","steps":"[{\\"num\\":1,\\"desc\\":\\"无权限账号访问配置页\\",\\"result\\":\\"访问被拦截\\"}]","tags":"[\\"Minimum Booking\\",\\"权限\\",\\"P1\\"]"}',
].join('\n');

const mapping = node.parameters.workflowInputs?.value;
if (!mapping) throw new Error('ms_create_test_case workflow input mapping was not found');

mapping.name = "={{ $fromAI('name', '测试用例名称，必填，最多 255 个字符。', 'string') }}";
mapping.node_id = "={{ $fromAI('node_id', '目标叶子模块 UUID，必填。必须原样使用 ms_list_modules 返回的最终子文件夹 id，不要传模块路径、名称、父文件夹 id 或同级汇总文件夹 id。嵌套示例：目标 /AI Draft/Minimum Booking Policy V1/01 Pricing Rule 配置，应传 01 Pricing Rule 配置 的 id。', 'string') }}";
mapping.node_path = "={{ $fromAI('node_path', '目标叶子模块完整路径，必填。必须原样使用 ms_list_modules 返回的 path，并与 node_id 属于同一条结果。例如：/AI Draft/Minimum Booking Policy V1/01 Pricing Rule 配置。', 'string') }}";
mapping.priority = "={{ $fromAI('priority', '用例等级，只能是 P0、P1、P2、P3；默认 P2。', 'string') }}";
mapping.maintainer = "={{ $fromAI('maintainer', 'MeterSphere 责任人账号标识，例如 jiabowang@moego.pet；留空时默认 jiabowang@moego.pet。', 'string') }}";
mapping.prerequisite = "={{ $fromAI('prerequisite', '前置条件；没有时传空字符串。', 'string') }}";
mapping.step_model = "={{ $fromAI('step_model', '步骤模型，结构化步骤使用 STEP。', 'string') }}";
mapping.step_description = "={{ $fromAI('step_description', '非结构化步骤描述；使用 STEP 时通常传空字符串。', 'string') }}";
mapping.expected_result = "={{ $fromAI('expected_result', '整体预期结果；没有时传空字符串。每个结构化步骤的预期结果仍放在 steps[].result。', 'string') }}";
mapping.steps = "={{ $fromAI('steps', 'JSON 数组字符串。示例：[{\"num\":1,\"desc\":\"打开页面\",\"result\":\"页面正常展示\"}]。禁止传普通文本或逗号列表。', 'string') }}";
mapping.tags = "={{ $fromAI('tags', 'JSON 数组字符串。示例：[\"FIN-7119\",\"P1\",\"回归\"]。禁止传 FIN-7119,P1,回归 这种逗号字符串。', 'string') }}";

const schema = node.parameters.workflowInputs?.schema ?? [];
if (!schema.some((field) => field.id === 'node_path')) {
  const nodeIdIndex = schema.findIndex((field) => field.id === 'node_id');
  schema.splice(nodeIdIndex + 1, 0, {
    id: 'node_path',
    displayName: 'node_path（完整路径，必填）',
    required: true,
    defaultMatch: false,
    display: true,
    canBeUsedToMatch: true,
    type: 'string',
    removed: false,
  });
}
for (const field of schema) {
  if (field.id === 'name') {
    field.displayName = 'name（必填）';
    field.required = true;
  }
  if (field.id === 'node_id') {
    field.displayName = 'node_id（模块 UUID，必填）';
    field.required = true;
  }
  if (field.id === 'node_path') {
    field.displayName = 'node_path（完整路径，必填）';
    field.required = true;
  }
  if (field.id === 'maintainer') field.displayName = 'maintainer（账号标识）';
  if (field.id === 'tags') field.displayName = 'tags（JSON 数组字符串，禁止逗号串）';
  if (field.id === 'steps') field.displayName = 'steps（JSON 数组字符串）';
}

const listModulesNode = (workflow.nodes ?? []).find((candidate) => candidate.name === 'ms_list_modules');
if (listModulesNode) {
  listModulesNode.parameters.description = [
    '按条件查询 MeterSphere 模块，返回精简的模块 UUID、完整路径、父节点、是否叶子节点和直属子节点数量。创建用例前先调用本工具选择目标模块。',
    'query、node_id、parent_id 三个选择器最多传一个：query 按名称或完整路径搜索；node_id 精确查询一个 UUID；parent_id 只列该节点的直属子节点。',
    '不传选择器时只返回顶层节点，不再返回整棵模块树。结果默认 20 条、最多 100 条；truncated=true 时用 next_offset 继续分页。',
    '如果目标路径包含子文件夹，必须使用 is_leaf=true 的最终叶子文件夹 id；不要使用其父文件夹或旁边的汇总文件夹 id。',
    '选择时必须核对完整 path，不能只比较最后一级名称；存在相似名称时不要猜测 UUID。MeterSphere 以 node_id 决定列表归属。',
    '示例：query=Minimum Booking Policy V1；再用 parent_id=cdfb490b-677e-449d-b51c-11b3d93e7505 列出七个直属子文件夹。',
    '目标 /AI Draft/Minimum Booking Policy V1/01 Pricing Rule 配置，应选择 path 完全匹配且 is_leaf=true 的 aa79b6a0-6789-4bf7-9b35-dd643a4b9983。',
  ].join('\n');

  listModulesNode.parameters.workflowInputs = {
    mappingMode: 'defineBelow',
    value: {
      query: "={{ $fromAI('query', '可选。按模块名称或完整路径进行不区分大小写的包含搜索，例如 Minimum Booking Policy V1。query、node_id、parent_id 最多传一个。', 'string') }}",
      node_id: "={{ $fromAI('node_id', '可选。精确查询一个模块 UUID。query、node_id、parent_id 最多传一个。', 'string') }}",
      parent_id: "={{ $fromAI('parent_id', '可选。只返回该父模块的直属子节点，用于逐层浏览。query、node_id、parent_id 最多传一个。', 'string') }}",
      offset: "={{ $fromAI('offset', '分页偏移量，默认 0；仅当 truncated=true 时使用返回的 next_offset 继续查询。', 'number', 0) }}",
      limit: "={{ $fromAI('limit', '每页数量，默认 20，最小 1，最大 100。', 'number', 20) }}",
    },
    matchingColumns: [],
    schema: [
      { id: 'query', displayName: 'query（名称或路径搜索）', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false },
      { id: 'node_id', displayName: 'node_id（精确 UUID）', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false },
      { id: 'parent_id', displayName: 'parent_id（列直属子节点）', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false },
      { id: 'offset', displayName: 'offset', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number', removed: false },
      { id: 'limit', displayName: 'limit（1-100）', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number', removed: false },
    ],
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
}

process.stdout.write(JSON.stringify(workflow));
