import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected MeterSphere MCP workflow JSON on stdin');

const workflow = JSON.parse(input);
const tool = (workflow.nodes ?? []).find(
  (node) => node.name === 'ms_create_module' || node.name === 'ms_upsert_module',
);
if (!tool) throw new Error('MeterSphere module tool node was not found');

const previousToolName = tool.name;
tool.name = 'ms_upsert_module';

tool.parameters.description = `Upsert one MeterSphere module under an existing parent module.

Before calling, use ms_list_modules to resolve exact UUIDs. This tool is backward compatible with create-only callers:
- Create or reuse: leave module_id empty, then pass name and parent_id. An existing same-name sibling is reused; otherwise a new module is created.
- Update: pass the existing module_id plus the desired full name and parent_id. The module is renamed and/or moved with MeterSphere /track/case/node/edit.

Parameters:
- module_id: optional bare UUID of the module to edit. Leave empty only for create/reuse.
- name: required desired module/folder name, maximum 255 characters, no slash (/).
- parent_id: required bare UUID of the desired parent module.

Default placement for create: unless the user requests another location, use AI Draft parent_id b3728e0a-b654-4b8b-876d-77c0e1b4ee0f.

Safety behavior: IDs must be copied exactly from ms_list_modules. The workflow rejects duplicate sibling names, malformed IDs, missing nodes, and moves under the module itself or one of its descendants. It fixes level=2 internally and verifies the final ID, parent, path, level, and sibling uniqueness after every write.

Create example:
{"module_id":"","name":"FIN-7119 Payment Flow - Split tips 新用例","parent_id":"b3728e0a-b654-4b8b-876d-77c0e1b4ee0f"}

Update example:
{"module_id":"14ab174a-1030-4ecc-bcac-37938792c158","name":"ABC","parent_id":"b3728e0a-b654-4b8b-876d-77c0e1b4ee0f"}`;

tool.parameters.workflowInputs = {
  mappingMode: 'defineBelow',
  value: {
    module_id: "={{ $fromAI('module_id', 'Optional existing MeterSphere module UUID to rename or move. Copy the exact id from ms_list_modules. Leave empty for create/reuse.', 'string', '') }}",
    name: "={{ $fromAI('name', 'Required desired MeterSphere module name, maximum 255 characters, no slash (/).', 'string') }}",
    parent_id: "={{ $fromAI('parent_id', 'Required bare UUID of the desired parent module, copied exactly from ms_list_modules. For create, default to AI Draft unless another parent was requested.', 'string', 'b3728e0a-b654-4b8b-876d-77c0e1b4ee0f') }}",
  },
  matchingColumns: [],
  schema: [
    {
      id: 'module_id',
      displayName: 'module_id（更新时必填；创建时留空）',
      required: false,
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: true,
      type: 'string',
      removed: false,
    },
    {
      id: 'name',
      displayName: 'name（目标名称，必填）',
      required: true,
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: true,
      type: 'string',
      removed: false,
    },
    {
      id: 'parent_id',
      displayName: 'parent_id（目标父模块 UUID，必填）',
      required: true,
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: true,
      type: 'string',
      removed: false,
    },
  ],
  attemptToConvertTypes: false,
  convertFieldsToString: false,
};
tool.parameters.workflowId.cachedResultName = 'ms_upsert_module';

const previousConnection = workflow.connections?.[previousToolName];
if (!previousConnection) throw new Error('MeterSphere module tool connection was not found');
delete workflow.connections[previousToolName];
workflow.connections[tool.name] = previousConnection;

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
  description: typeof workflow.description === 'string' ? workflow.description : '',
}));
