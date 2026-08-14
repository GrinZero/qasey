import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const workflowDir = path.join(projectRoot, 'n8n-workflows', 'metersphere');
const createWorkflowPath = path.join(workflowDir, 'ms_create_test_case.json');

const createWorkflow = JSON.parse(fs.readFileSync(createWorkflowPath, 'utf8'));
const createCode = createWorkflow.nodes.find((node) => node.name === 'Create Test Case')?.parameters?.jsCode;
if (!createCode) throw new Error('Unable to find Create Test Case code in ' + createWorkflowPath);

function readConstant(name) {
  const match = createCode.match(new RegExp(`const ${name} = '([^']*)';`));
  if (!match) throw new Error('Unable to read ' + name + ' from the existing MeterSphere workflow');
  return match[1];
}

const configBlock = [
  ['accessKey', readConstant('accessKey')],
  ['secretKey', readConstant('secretKey')],
  ['baseUrl', readConstant('baseUrl')],
  ['projectId', readConstant('projectId')],
  ['workspaceId', readConstant('workspaceId')],
].map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`).join('\n');

function loadCode(fileName) {
  const source = fs.readFileSync(path.join(workflowDir, fileName), 'utf8');
  if (!source.includes('/*__MS_CONFIG__*/')) throw new Error(fileName + ' is missing the config marker');
  return source.replace('/*__MS_CONFIG__*/', configBlock);
}

function triggerInputs(fields) {
  return {
    workflowInputs: {
      values: fields.map((field) => ({
        name: field.name,
        ...(field.type ? { type: field.type } : {}),
      })),
    },
  };
}

function buildWorkflow({ name, codeFile, codeNodeName, fields, notes }) {
  return {
    name,
    nodes: [
      {
        parameters: triggerInputs(fields),
        id: 'trigger',
        name: 'When Executed by Another Workflow',
        type: 'n8n-nodes-base.executeWorkflowTrigger',
        typeVersion: 1.1,
        position: [0, 0],
      },
      {
        parameters: { jsCode: loadCode(codeFile) },
        id: 'operation',
        name: codeNodeName,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [260, 0],
        notes,
      },
    ],
    connections: {
      'When Executed by Another Workflow': {
        main: [[{ node: codeNodeName, type: 'main', index: 0 }]],
      },
    },
    settings: {
      executionOrder: 'v1',
      callerPolicy: 'workflowsFromSameOwner',
    },
  };
}

const workflows = [
  {
    output: 'ms_batch_edit_test_cases.json',
    workflow: buildWorkflow({
      name: 'ms_batch_edit_test_cases',
      codeFile: 'ms_batch_edit_test_cases-code.js',
      codeNodeName: 'Batch Edit Test Cases',
      fields: [
        { name: 'case_ids' },
        { name: 'field' },
        { name: 'value' },
        { name: 'tag_mode' },
        { name: 'dry_run', type: 'boolean' },
      ],
      notes: 'Safe wrapper around /track/test/case/batch/edit. It forbids selectAll, caps explicit UUIDs at 50, and verifies every updated case.',
    }),
  },
  {
    output: 'ms_bulk_upsert_test_cases.json',
    workflow: buildWorkflow({
      name: 'ms_bulk_upsert_test_cases',
      codeFile: 'ms_bulk_upsert_test_cases-code.js',
      codeNodeName: 'Bulk Upsert Test Cases',
      fields: [
        { name: 'items' },
        { name: 'dry_run', type: 'boolean' },
      ],
      notes: 'Restricted wrapper around /track/test/case/minder/edit. Deletion IDs, module mutations, and extra mind-map nodes are never accepted and are forced to empty values.',
    }),
  },
];

for (const item of workflows) {
  const outputPath = path.join(workflowDir, item.output);
  fs.writeFileSync(outputPath, JSON.stringify(item.workflow, null, 2) + '\n');
  process.stdout.write(outputPath + '\n');
}
