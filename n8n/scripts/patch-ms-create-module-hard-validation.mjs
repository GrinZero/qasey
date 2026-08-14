import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected workflow JSON on stdin');

const workflow = JSON.parse(input);
const trigger = (workflow.nodes ?? []).find(
  (node) => node.type === 'n8n-nodes-base.executeWorkflowTrigger',
);
const createNode = (workflow.nodes ?? []).find((node) => node.name === 'Create Module');
if (!trigger || !createNode) throw new Error('Create module workflow nodes were not found');

trigger.parameters.workflowInputs = {
  values: [
    { name: 'name', type: 'string' },
    { name: 'parent_id', type: 'string' },
  ],
};

const existingCode = createNode.parameters?.jsCode;
if (typeof existingCode !== 'string') throw new Error('Create Module code was not found');
const constantsEnd = existingCode.indexOf('\n\nconst timestamp = Date.now();');
if (constantsEnd < 0) throw new Error('MeterSphere configuration constants were not found');
const configuration = existingCode.slice(0, constantsEnd);

const implementation = String.raw`

function requestHeaders() {
  const timestamp = Date.now();
  const uuid = crypto.randomUUID();
  const comboxKey = accessKey + '|' + uuid + '|' + timestamp;
  const key = Buffer.from(secretKey.slice(0, 16), 'utf-8');
  const iv = Buffer.from(accessKey.slice(0, 16), 'utf-8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let signature = cipher.update(comboxKey, 'utf-8', 'base64');
  signature += cipher.final('base64');
  return {
    'Content-Type': 'application/json',
    ACCEPT: 'application/json',
    accessKey,
    signature,
    project: projectId,
    workspace: workspaceId,
  };
}

function parseEnvelope(response, operation) {
  const envelope = typeof response === 'string' ? JSON.parse(response) : response;
  if (!envelope?.success) {
    throw new Error('[upstream_error] MeterSphere ' + operation + ' failed: ' + (envelope?.message || 'unknown error'));
  }
  return envelope.data;
}

async function readModuleTree() {
  const response = await helpers.httpRequest({
    method: 'GET',
    url: baseUrl + '/track/case/node/list/' + projectId,
    headers: requestHeaders(),
    json: true,
  });
  return parseEnvelope(response, 'module tree lookup');
}

function flattenModules(nodes, parentPath = '', ancestorIds = []) {
  const modules = [];
  for (const node of nodes || []) {
    const path = parentPath ? parentPath + '/' + node.name : '/' + node.name;
    const children = Array.isArray(node.children) ? node.children : [];
    modules.push({
      id: node.id,
      name: node.name,
      path,
      parentId: node.parentId || null,
      level: Number(node.level),
      ancestorIds,
      children,
    });
    modules.push(...flattenModules(children, path, [...ancestorIds, node.id]));
  }
  return modules;
}

const request = $input.first().json;
const name = String(request.name ?? '').trim();
const parentId = String(request.parent_id ?? '').trim();
if (!name) throw new Error('[validation_error] name is required');
if (name.length > 255) throw new Error('[validation_error] name must not exceed 255 characters');
if (name.includes('/')) throw new Error('[validation_error] name must not contain / because module paths use / as a separator');
if (!parentId) throw new Error('[validation_error] parent_id is required; use the exact module UUID from ms_list_modules');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentId)) {
  throw new Error('[validation_error] parent_id must be one bare UUID with no comma, Chinese punctuation, module name, or path');
}

const beforeTree = await readModuleTree();
const beforeModules = flattenModules(beforeTree);
const parentMatches = beforeModules.filter((module) => module.id === parentId);
if (parentMatches.length === 0) {
  throw new Error('[validation_error] parent_id was not found in the MeterSphere module tree: ' + parentId);
}
if (parentMatches.length > 1) {
  throw new Error('[tree_conflict] parent_id appears in more than one tree position; repair the parent module before creating children: ' + parentId);
}

const parent = parentMatches[0];
const level = 2;
const expectedPath = parent.path + '/' + name;
const existingSiblings = beforeModules.filter((module) =>
  module.parentId === parentId && module.name === name,
);
if (existingSiblings.length > 1) {
  throw new Error('[tree_conflict] more than one sibling already has the requested name: ' + expectedPath);
}
if (existingSiblings.length === 1) {
  const existing = existingSiblings[0];
  const existingOccurrences = beforeModules.filter((module) => module.id === existing.id);
  if (existingOccurrences.length !== 1 || existing.path !== expectedPath || existing.level !== level) {
    throw new Error('[tree_conflict] the existing module has inconsistent tree metadata and must be repaired: ' + existing.id);
  }
  return [{ json: {
    id: existing.id,
    name,
    parent_id: parentId,
    parent_path: parent.path,
    path: existing.path,
    level,
    created: false,
    reused: true,
    verified: true,
    message: 'Module already existed under the requested parent; reused after tree verification',
  } }];
}

const body = {
  level,
  type: 'add',
  parentId,
  name,
  label: name,
  projectId,
};
const createResponse = await helpers.httpRequest({
  method: 'POST',
  url: baseUrl + '/track/case/node/add',
  headers: requestHeaders(),
  body,
  json: true,
});
const createdData = parseEnvelope(createResponse, 'module create');
const id = typeof createdData === 'string' ? createdData : createdData?.id;
if (!id) throw new Error('[postcondition_error] MeterSphere create succeeded without returning a module id');

const afterTree = await readModuleTree();
const afterModules = flattenModules(afterTree);
const createdMatches = afterModules.filter((module) => module.id === id);
if (createdMatches.length !== 1) {
  const paths = createdMatches.map((module) => module.path).join(', ') || '(not reachable)';
  throw new Error(
    '[postcondition_error] Created module ' + id + ' must appear exactly once in the tree; found '
    + createdMatches.length + ' positions: ' + paths,
  );
}
const created = createdMatches[0];
if (created.parentId !== parentId || created.path !== expectedPath || created.level !== level) {
  throw new Error(
    '[postcondition_error] Created module has incorrect tree metadata. Expected parent_id=' + parentId
    + ', path=' + expectedPath + ', level=' + level
    + '; actual parent_id=' + created.parentId + ', path=' + created.path + ', level=' + created.level,
  );
}

return [{ json: {
  id,
  name,
  parent_id: parentId,
  parent_path: parent.path,
  path: created.path,
  level,
  created: true,
  reused: false,
  verified: true,
  message: 'Module created and unique tree placement verified',
} }];
`;

createNode.parameters.jsCode = configuration + implementation;
createNode.retryOnFail = true;
createNode.maxTries = 3;
createNode.waitBetweenTries = 1000;

workflow.description = 'Create or idempotently reuse one MeterSphere module under an existing parent UUID. Inputs: name and parent_id. The workflow validates the parent, derives level internally, and verifies the resulting module appears exactly once at the expected path.';

process.stdout.write(JSON.stringify(workflow));
