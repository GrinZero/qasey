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

function patchToolContract(name, descriptionLines, values, fields) {
  const tool = (workflow.nodes ?? []).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool node was not found`);

  tool.parameters.description = descriptionLines.join('\n');
  const workflowInputs = tool.parameters.workflowInputs;
  if (!workflowInputs) throw new Error(`${name} workflow input mapping was not found`);

  workflowInputs.value = { ...workflowInputs.value, ...values };
  workflowInputs.attemptToConvertTypes = false;
  workflowInputs.convertFieldsToString = false;

  const schemaById = new Map((workflowInputs.schema ?? []).map((field) => [field.id, field]));
  for (const [id, updates] of Object.entries(fields)) {
    const field = schemaById.get(id);
    if (!field) throw new Error(`${name} schema field ${id} was not found`);
    Object.assign(field, updates);
  }
}

patchToolContract(
  'ms_get_review_detail',
  [
    '读取一条 MeterSphere 测试评审的完整详情，包括评审状态、规则、评审人和分页用例列表。先用 ms_list_case_reviews 找到评审，再把其 id 原样传入；不要传评审名称或测试用例 ID。',
    'review_id 必填，必须是 ms_list_case_reviews 返回的评审 UUID。page 和 page_size 只控制评审内用例列表，均为正整数，默认 1 和 20。',
    '当只需要浏览或筛选评审时使用 ms_list_case_reviews；确认某一条评审的参与人和用例明细时才使用本工具。',
  ],
  {
    review_id: "={{ $fromAI('review_id', '必填。ms_list_case_reviews 返回的评审 id（UUID），必须原样复制；不要传名称、测试用例 id 或 URL。', 'string') }}",
    page: "={{ $fromAI('page', '评审内用例列表页码，正整数，默认 1。', 'number', 1) }}",
    page_size: "={{ $fromAI('page_size', '评审内每页用例数量，正整数，默认 20。', 'number', 20) }}",
  },
  {
    review_id: { displayName: 'review_id（评审 UUID，必填）', required: true, type: 'string' },
    page: { displayName: 'page（正整数）', required: false, type: 'number' },
    page_size: { displayName: 'page_size（正整数）', required: false, type: 'number' },
  },
);

patchToolContract(
  'ms_get_test_case_detail',
  [
    '读取一条 MeterSphere 功能测试用例的完整详情，包括模块路径、优先级、状态、责任人、前置条件、步骤、预期结果、标签和关联缺陷。用于已定位到单条用例后的详情核对，不用于搜索或列举。',
    'case_id 必填，只允许 ms_list_test_cases 返回的 canonical UUID id。返回结果里的纯数字 num 只是展示用例编号，不能作为 case_id。',
    '不要传 module_id、模块 URL 中的 moduleId、用例名称、完整 URL、纯数字 num，或从其他字段猜出的 UUID 形字符串。如果还不知道目标用例，先调用 ms_list_test_cases 按 name 或 node_id 筛选，再原样复制目标结果的 id。',
    '正确形态示例：case_id="97bb25db-18df-428e-af86-be305ad8b2ff"。UUID 必须符合 RFC variant/version 形式；仅仅长得像 8-4-4-4-12 的字符串不一定有效。',
  ],
  {
    case_id: "={{ $fromAI('case_id', '必填。只允许原样使用 ms_list_test_cases 返回的 canonical UUID id。禁止传纯数字 num、module_id、模块 URL 参数、用例名称、完整 URL 或猜测的 UUID。', 'string') }}",
  },
  {
    case_id: { displayName: 'case_id（用例 UUID，必填）', required: true, type: 'string' },
  },
);

patchToolContract(
  'ms_list_case_reviews',
  [
    '分页列出当前 MeterSphere 项目的测试评审摘要，返回评审 id、名称、状态、创建人、通过率、用例数、评审人和时间。用于浏览或定位评审，不返回评审内的完整用例明细。',
    'page 和 page_size 均为正整数，默认 1 和 20。找到目标评审后，把返回的 id 原样传给 ms_get_review_detail 查看评审人和用例列表。',
  ],
  {
    page: "={{ $fromAI('page', '评审列表页码，正整数，默认 1。', 'number', 1) }}",
    page_size: "={{ $fromAI('page_size', '每页评审数量，正整数，默认 20。', 'number', 20) }}",
  },
  {
    page: { displayName: 'page（正整数）', required: false, type: 'number' },
    page_size: { displayName: 'page_size（正整数）', required: false, type: 'number' },
  },
);

patchToolContract(
  'ms_list_projects',
  [
    '列出当前凭证可见的 MeterSphere 项目，返回项目 id、名称等基础信息。用于确认项目身份或获取项目 UUID；不需要任何参数，也不返回模块或测试用例。',
    '要浏览项目内模块使用 ms_list_modules；要浏览功能测试用例使用 ms_list_test_cases。',
  ],
  {},
  {},
);

patchToolContract(
  'ms_list_test_cases',
  [
    '分页列出或筛选当前 MeterSphere 项目的功能测试用例摘要，返回每条用例的 canonical UUID id、数字用例号 num、名称、模块路径、优先级、状态、责任人和标签。用于搜索与定位，不返回完整步骤和关联缺陷。',
    'name 可按用例名称模糊筛选；node_id 可限定到一个模块，必须原样使用 ms_list_modules 返回的模块 UUID。page 和 page_size 均为正整数，默认 1 和 20；结果里的 total 和 page_count 用于继续翻页。',
    '需要单条完整详情时，只能把本工具返回的 canonical UUID id 原样传给 ms_get_test_case_detail。num 只是展示用例编号，不能作为 case_id；node_id、URL 中的 moduleId 和用例名称也都不是 case_id。',
  ],
  {
    page: "={{ $fromAI('page', '用例列表页码，正整数，默认 1。', 'number', 1) }}",
    page_size: "={{ $fromAI('page_size', '每页用例数量，正整数，默认 20。', 'number', 20) }}",
    name: "={{ $fromAI('name', '可选。测试用例名称的模糊搜索关键词；不要传模块名称或用例 ID。', 'string', '') }}",
    node_id: "={{ $fromAI('node_id', '可选。用于限定模块的 UUID，必须原样使用 ms_list_modules 返回的 id；不要传模块路径、名称或 case_id。', 'string', '') }}",
  },
  {
    page: { displayName: 'page（正整数）', required: false, type: 'number' },
    page_size: { displayName: 'page_size（正整数）', required: false, type: 'number' },
    name: { displayName: 'name（名称模糊筛选）', required: false, type: 'string' },
    node_id: { displayName: 'node_id（模块 UUID）', required: false, type: 'string' },
  },
);

patchToolContract(
  'ms_edit_test_case',
  [
    '完整编辑一条既有 MeterSphere 功能测试用例。仅在用户明确要求修改单条用例且必须使用旧版单条编辑接口时调用；通常优先使用支持 dry_run 和回查的 ms_bulk_upsert_test_cases。',
    '这是全量覆盖语义，不是安全的局部 patch：case_id 和 name 必填，未传的 priority、maintainer、status 会回落到默认值，未传的步骤、标签和文本字段可能被清空。调用前必须先用 ms_get_test_case_detail 读取现值，并把所有要保留的字段一并传回。',
    'case_id 必须是 ms_list_test_cases 或 ms_get_test_case_detail 返回的 canonical UUID id，不能传数字 num。node_id 可选；留空时保留现有模块，传入时必须是 ms_list_modules 返回的目标模块 UUID。',
    'steps 和 tags 必须是 JSON 数组字符串。steps 示例：[{"num":1,"desc":"操作","result":"预期"}]；tags 示例：["回归","P1"]。',
  ],
  {
    case_id: "={{ $fromAI('case_id', '必填。既有用例的 canonical UUID id，原样使用 ms_list_test_cases 或 ms_get_test_case_detail 返回的 id；禁止传数字 num、名称或 URL。', 'string') }}",
    name: "={{ $fromAI('name', '必填。编辑后的完整用例名称；即使名称不变也要传当前值。', 'string') }}",
    node_id: "={{ $fromAI('node_id', '可选。目标模块 UUID，必须来自 ms_list_modules；留空时保留现有模块。', 'string', '') }}",
    priority: "={{ $fromAI('priority', '完整用例优先级，只能是 P0、P1、P2、P3。省略会回落到 P2，因此要保留原值时必须显式传入。', 'string') }}",
    maintainer: "={{ $fromAI('maintainer', '完整责任人账号标识。省略会回落到默认账号，因此要保留原值时必须显式传入。', 'string') }}",
    prerequisite: "={{ $fromAI('prerequisite', '完整前置条件文本；空字符串会清空现值。', 'string') }}",
    step_model: "={{ $fromAI('step_model', '完整步骤模型，结构化步骤通常为 STEP。', 'string') }}",
    step_description: "={{ $fromAI('step_description', '完整非结构化步骤描述；STEP 模式通常传空字符串。', 'string') }}",
    expected_result: "={{ $fromAI('expected_result', '完整整体预期结果；空字符串会清空现值。', 'string') }}",
    steps: "={{ $fromAI('steps', '完整步骤 JSON 数组字符串，例如 [{\"num\":1,\"desc\":\"操作\",\"result\":\"预期\"}]；空数组会清空步骤。', 'string') }}",
    tags: "={{ $fromAI('tags', '完整标签 JSON 数组字符串，例如 [\"回归\",\"P1\"]；空数组会清空标签。', 'string') }}",
    status: "={{ $fromAI('status', '完整用例状态。省略会回落到 Prepare，因此要保留原值时必须显式传入。', 'string') }}",
  },
  {
    case_id: { displayName: 'case_id（用例 UUID，必填）', required: true, type: 'string' },
    name: { displayName: 'name（完整名称，必填）', required: true, type: 'string' },
    node_id: { displayName: 'node_id（目标模块 UUID）', required: false, type: 'string' },
    priority: { displayName: 'priority（P0-P3）', required: false, type: 'string' },
    maintainer: { displayName: 'maintainer（账号标识）', required: false, type: 'string' },
    prerequisite: { displayName: 'prerequisite（完整值）', required: false, type: 'string' },
    step_model: { displayName: 'step_model（完整值）', required: false, type: 'string' },
    step_description: { displayName: 'step_description（完整值）', required: false, type: 'string' },
    expected_result: { displayName: 'expected_result（完整值）', required: false, type: 'string' },
    steps: { displayName: 'steps（完整 JSON 数组字符串）', required: false, type: 'string' },
    tags: { displayName: 'tags（完整 JSON 数组字符串）', required: false, type: 'string' },
    status: { displayName: 'status（完整值）', required: false, type: 'string' },
  },
);

patchToolContract(
  'ms_upsert_module',
  [
    '创建、复用、重命名或移动一个 MeterSphere 模块。用于单模块 upsert，不用于删除；删除模块必须使用带强制 Slack 审批的 ms_delete_modules。',
    '调用前先用 ms_list_modules 获取准确 UUID。创建或复用时 module_id 留空，并传完整 name 与 parent_id；更新时传既有 module_id、目标 name 和目标 parent_id。所有 ID 都必须从 ms_list_modules 原样复制，不能传名称、路径或猜测值。',
    'name 最多 255 个字符且不能包含 /。parent_id 必填；未明确指定创建位置时默认使用 AI Draft。工作流会拒绝同级重名、非法树移动和不存在的 ID，并在写入后回查最终 id、parent、path、level 与同级唯一性。',
    'operation、module_ids 和 dry_run 由工作流固定为 upsert 安全路径，不向模型开放；需要删除时改用 ms_delete_modules。',
  ],
  {
    module_id: "={{ $fromAI('module_id', '可选。要重命名或移动的既有模块 UUID，必须原样使用 ms_list_modules 返回的 id；创建或复用时传空字符串。', 'string', '') }}",
    name: "={{ $fromAI('name', '必填。目标模块完整名称，最多 255 个字符，不能包含 /。', 'string') }}",
    parent_id: "={{ $fromAI('parent_id', '必填。目标父模块 UUID，必须原样使用 ms_list_modules 返回的 id；创建时用户未指定位置则使用 AI Draft。', 'string', 'b3728e0a-b654-4b8b-876d-77c0e1b4ee0f') }}",
    operation: 'upsert',
    module_ids: '[]',
    dry_run: false,
  },
  {
    module_id: { displayName: 'module_id（既有模块 UUID）', required: false, type: 'string' },
    name: { displayName: 'name（完整名称，必填）', required: true, type: 'string' },
    parent_id: { displayName: 'parent_id（父模块 UUID，必填）', required: true, type: 'string' },
    operation: { displayName: 'operation（固定 upsert）', required: false, type: 'string' },
    module_ids: { displayName: 'module_ids（固定为空）', required: false, type: 'string' },
    dry_run: { displayName: 'dry_run（固定 false）', required: false, type: 'boolean' },
  },
);

process.stdout.write(JSON.stringify(workflow));
