import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected workflow JSON on stdin');

const workflow = JSON.parse(input);
const trigger = (workflow.nodes ?? []).find(
  (node) => node.type === 'n8n-nodes-base.executeWorkflowTrigger',
);
const createNode = (workflow.nodes ?? []).find((node) => node.name === 'Create Test Case');
if (!trigger || !createNode) throw new Error('Create workflow nodes were not found');

const values = trigger.parameters?.workflowInputs?.values;
if (!Array.isArray(values)) throw new Error('Create workflow input schema was not found');
if (!values.some((field) => field.name === 'node_path')) {
  const nodeIdIndex = values.findIndex((field) => field.name === 'node_id');
  values.splice(nodeIdIndex + 1, 0, { name: 'node_path' });
}

let code = createNode.parameters?.jsCode;
if (typeof code !== 'string') throw new Error('Create Test Case code was not found');

code = code.replace(
  "if (!input.name) throw new Error('name is required');\nif (!input.node_id) throw new Error('node_id is required');\n\nconst priority = input.priority || 'P2';",
  "const caseName = String(input.name ?? '').trim();\n"
    + "if (!caseName) throw new Error('[validation_error] name is required');\n"
    + "if (caseName.length > 255) throw new Error('[validation_error] name must not exceed 255 characters');\n"
    + "if (!input.node_id && !input.node_path) throw new Error('[validation_error] node_id or node_path is required');\n\n"
    + "const priority = input.priority || 'P2';\n"
    + "if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) {\n"
    + "  throw new Error('[validation_error] priority must be one of P0, P1, P2, P3');\n"
    + "}",
);

const resolver = String.raw`function normalizeNodePath(value) {
  const normalized = String(value ?? '').trim().replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized) return '';
  return normalized.startsWith('/') ? normalized : '/' + normalized;
}

async function resolveTargetNode(requestedNodeId, requestedNodePath) {
  const response = await helpers.httpRequest({
    method: 'GET',
    url: baseUrl + '/track/case/node/list/' + projectId,
    headers: {
      'Content-Type': 'application/json',
      'ACCEPT': 'application/json',
      'accessKey': accessKey,
      'signature': signature,
      'project': projectId,
      'workspace': workspaceId,
    },
    json: true,
  });

  const data = typeof response === 'string' ? JSON.parse(response) : response;
  if (!data.success) throw new Error('[upstream_error] Unable to read MeterSphere module tree: ' + data.message);

  const modules = [];
  function flatten(nodes, parentPath = '') {
    for (const node of nodes || []) {
      const path = parentPath ? parentPath + '/' + node.name : '/' + node.name;
      const children = Array.isArray(node.children) ? node.children : [];
      modules.push({
        id: node.id,
        name: node.name,
        path,
        parentId: node.parentId || null,
        childCount: children.length,
      });
      flatten(children, path);
    }
  }
  flatten(data.data);

  const normalizedPath = normalizeNodePath(requestedNodePath);
  let target = null;
  if (normalizedPath) {
    const pathMatches = modules.filter((module) => module.path === normalizedPath);
    if (pathMatches.length === 0) {
      throw new Error('[validation_error] node_path was not found: ' + normalizedPath);
    }
    if (pathMatches.length > 1) {
      throw new Error('[validation_error] node_path is ambiguous; pass the exact node_id: ' + normalizedPath);
    }
    target = pathMatches[0];
    if (requestedNodeId && target.id !== requestedNodeId) {
      throw new Error(
        '[validation_error] node_id and node_path do not identify the same module. '
        + 'Path resolves to ' + target.id + ', but received ' + requestedNodeId,
      );
    }
  } else {
    target = modules.find((module) => module.id === requestedNodeId) || null;
    if (!target) {
      throw new Error('[validation_error] node_id was not found in the MeterSphere module tree: ' + requestedNodeId);
    }
  }

  if (target.childCount > 0) {
    throw new Error(
      '[validation_error] target module is not a leaf. Select one of its child modules instead: '
      + target.path + ' (' + target.childCount + ' children)',
    );
  }
  return target;
}

const targetNode = await resolveTargetNode(input.node_id, input.node_path);
const targetNodeId = targetNode.id;
const nodePath = targetNode.path;
`;

const resolverPattern = /async function resolveNodePath\(nodeId\) \{[\s\S]*?const nodePath = await resolveNodePath\(targetNodeId\);\n/;
if (!resolverPattern.test(code)) throw new Error('Existing node resolver block was not found');
code = code.replace(resolverPattern, resolver);

code = code.replace('  name: input.name,', '  name: caseName,');

const dryRunAnchor = "const boundary = '------WebKitFormBoundary'";
if (!code.includes(dryRunAnchor)) throw new Error('Create request boundary was not found');
code = code.replace(
  dryRunAnchor,
  "if (input.dry_run === true) {\n"
    + "  return [{ json: { success: true, dry_run: true, name: caseName, node_id: targetNodeId, node_path: nodePath, is_leaf: true, priority, message: 'Validation passed; no test case was created' } }];\n"
    + "}\n\n"
    + dryRunAnchor,
);

const oldTail = "const data = typeof response === 'string' ? JSON.parse(response) : response;\n"
  + "if (!data.success) throw new Error(`MeterSphere error: ${data.message}`);\n"
  + "const c = data.data;\n"
  + "return [{ json: { id: c.id, num: c.num, name: c.name, project_id: c.projectId, node_id: c.nodeId, priority: c.priority, status: c.status, maintainer: c.maintainer, create_time: c.createTime ? new Date(c.createTime).toISOString() : null, message: 'Test case created successfully' } }];";

const newTail = String.raw`const data = typeof response === 'string' ? JSON.parse(response) : response;
if (!data.success) throw new Error('[upstream_error] MeterSphere create failed: ' + data.message);
const c = data.data;

const detailResponse = await helpers.httpRequest({
  method: 'GET',
  url: baseUrl + '/track/test/case/get/' + c.id,
  headers: {
    'Content-Type': 'application/json',
    'ACCEPT': 'application/json',
    'accessKey': accessKey,
    'signature': signature,
    'project': projectId,
    'workspace': workspaceId,
  },
  json: true,
});
const detail = typeof detailResponse === 'string' ? JSON.parse(detailResponse) : detailResponse;
if (!detail.success) {
  throw new Error('[postcondition_error] Test case ' + c.id + ' was created, but detail verification failed: ' + detail.message);
}
const created = detail.data;
const actualPath = normalizeNodePath(created.nodePath);
if (created.nodeId !== targetNodeId || actualPath !== nodePath) {
  throw new Error(
    '[postcondition_error] Test case ' + c.id + ' was created in an unexpected module. '
    + 'Expected node_id=' + targetNodeId + ', node_path=' + nodePath
    + '; actual node_id=' + created.nodeId + ', node_path=' + actualPath,
  );
}

return [{ json: {
  id: created.id,
  num: created.num,
  name: created.name,
  project_id: created.projectId,
  node_id: created.nodeId,
  node_path: actualPath,
  priority: created.priority,
  status: created.status,
  maintainer: created.maintainer,
  verified: true,
  create_time: created.createTime ? new Date(created.createTime).toISOString() : null,
  message: 'Test case created and module ownership verified',
} }];`;

if (!code.includes(oldTail)) throw new Error('Existing create response tail was not found');
code = code.replace(oldTail, newTail);

for (const requiredText of [
  'resolveTargetNode(input.node_id, input.node_path)',
  'target module is not a leaf',
  'node_id and node_path do not identify the same module',
  'detail verification failed',
  'verified: true',
]) {
  if (!code.includes(requiredText)) throw new Error(`Missing hard validation block: ${requiredText}`);
}

createNode.parameters.jsCode = code;
process.stdout.write(JSON.stringify(workflow));
