import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected Trigger workflow JSON on stdin');

const workflow = JSON.parse(input);
const tool = (workflow.nodes ?? []).find((node) => node.name === 'ms_create_module');
if (!tool) throw new Error('ms_create_module tool node was not found');

tool.parameters.description = `Create or idempotently reuse one MeterSphere module under an existing parent module.

Use this tool only when a new folder is required. Before calling it, use ms_list_modules to resolve the intended parent and copy its exact id.

Parameters:
- name: required module/folder name, maximum 255 characters, no slash (/).
- parent_id: required bare MeterSphere module UUID. Pass only the UUID returned by ms_list_modules, with no comma, Chinese comma, spaces, module name, or path.

Default placement: unless the user explicitly requests another location, use AI Draft as the parent. Its exact parent_id is b3728e0a-b654-4b8b-876d-77c0e1b4ee0f.

Do not pass level. The workflow intentionally does not expose level: every module with a parent must be sent to MeterSphere with level=2. It validates that parent_id exists, rejects malformed or ambiguous parents, reuses an existing same-name sibling, and verifies the resulting module ID appears exactly once at /<parent path>/<name>.

Correct example:
{"name":"FIN-7119 Payment Flow - Split tips 新用例","parent_id":"b3728e0a-b654-4b8b-876d-77c0e1b4ee0f"}

Invalid examples:
- parent_id="b3728e0a-b654-4b8b-876d-77c0e1b4ee0f," (trailing comma)
- parent_id="b3728e0a-b654-4b8b-876d-77c0e1b4ee0f，" (trailing Chinese comma)
- parent_id="AI Draft" or parent_id="/AI Draft" (name/path instead of UUID)
- adding a level parameter.`;

const workflowInputs = tool.parameters.workflowInputs;
workflowInputs.value = {
  name: "={{ $fromAI('name', 'Required MeterSphere module name, maximum 255 characters, no slash (/).', 'string') }}",
  parent_id: "={{ $fromAI('parent_id', 'Required bare parent module UUID copied exactly from ms_list_modules. No comma, Chinese punctuation, spaces, module name, or path. Use b3728e0a-b654-4b8b-876d-77c0e1b4ee0f for AI Draft unless another parent is explicitly required.', 'string', 'b3728e0a-b654-4b8b-876d-77c0e1b4ee0f') }}",
};
workflowInputs.schema = [
  {
    id: 'name',
    displayName: 'name（必填）',
    required: true,
    defaultMatch: false,
    display: true,
    canBeUsedToMatch: true,
    type: 'string',
    removed: false,
  },
  {
    id: 'parent_id',
    displayName: 'parent_id（父模块 UUID，必填）',
    required: true,
    defaultMatch: false,
    display: true,
    canBeUsedToMatch: true,
    type: 'string',
    removed: false,
  },
];
workflowInputs.matchingColumns = [];
workflowInputs.attemptToConvertTypes = false;
workflowInputs.convertFieldsToString = false;

process.stdout.write(JSON.stringify(workflow));
