import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected ms_get_test_case_detail workflow JSON on stdin');

const workflow = JSON.parse(input);
const signNode = workflow.nodes.find((node) => node.name === 'Generate Signature');
if (!signNode?.parameters?.jsCode) throw new Error('Generate Signature code node was not found');

const replacement = `const caseId = String($input.first().json.case_id ?? '').trim();
if (!caseId) throw new Error('[validation_error] case_id is required');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID_PATTERN.test(caseId)) {
  throw new Error('[validation_error] case_id must be the canonical UUID id returned by ms_list_test_cases; numeric num, module_id, names, and URLs are not accepted');
}
return [{ json: {
  baseUrl,
  caseId,
  headers: {
    'Content-Type': 'application/json',
    ACCEPT: 'application/json',
    accessKey,
    signature: encrypted,
  },
} }];`;

const numericCompatibilityBlock = /const rawCaseId = String\(\$input\.first\(\)\.json\.case_id[\s\S]*?return \[\{ json: \{[\s\S]*?\} \}\];/;
if (numericCompatibilityBlock.test(signNode.parameters.jsCode)) {
  signNode.parameters.jsCode = signNode.parameters.jsCode.replace(numericCompatibilityBlock, replacement);
} else {
  const legacyBlock = /const caseId = \$input\.first\(\)\.json\.case_id;[\s\S]*?return \[\{ json: \{ baseUrl, caseId, headers: \{[\s\S]*?\} \} \}\];/;
  if (!legacyBlock.test(signNode.parameters.jsCode)) {
    throw new Error('Neither numeric-compatibility nor legacy case_id block was found');
  }
  signNode.parameters.jsCode = signNode.parameters.jsCode.replace(legacyBlock, replacement);
}

const removedNames = new Set([
  'Is Numeric Case Number',
  'ms_list_test_cases for Number',
  'Resolve Numeric Case ID',
]);
workflow.nodes = workflow.nodes.filter((node) => !removedNames.has(node.name));

for (const removedName of removedNames) delete workflow.connections[removedName];
workflow.connections['Generate Signature'] = {
  main: [[{ node: 'Get Case Detail', type: 'main', index: 0 }]],
};

process.stdout.write(JSON.stringify(workflow));
