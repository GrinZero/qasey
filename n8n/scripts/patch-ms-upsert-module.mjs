import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected workflow JSON on stdin');

const workflow = JSON.parse(input);
const trigger = (workflow.nodes ?? []).find(
  (node) => node.type === 'n8n-nodes-base.executeWorkflowTrigger',
);
const upsertNode = (workflow.nodes ?? []).find(
  (node) => node.id === 'code' || node.name === 'Create Module' || node.name === 'Upsert Module',
);
if (!trigger || !upsertNode) throw new Error('Module workflow nodes were not found');

trigger.parameters.workflowInputs = {
  values: [
    { name: 'module_id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'parent_id', type: 'string' },
  ],
};

const existingCode = upsertNode.parameters?.jsCode;
if (typeof existingCode !== 'string') throw new Error('Module Code node implementation was not found');

const implementationMarkers = [
  '\n\nfunction requestHeaders()',
  '\n\nconst timestamp = Date.now();',
];
const implementationStart = implementationMarkers
  .map((marker) => existingCode.indexOf(marker))
  .filter((index) => index >= 0)
  .sort((left, right) => left - right)[0];
if (implementationStart == null) throw new Error('MeterSphere configuration constants were not found');
const configuration = existingCode.slice(0, implementationStart);

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
    });
    modules.push(...flattenModules(children, path, [...ancestorIds, node.id]));
  }
  return modules;
}

function assertUuid(value, field) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(
      '[validation_error] ' + field
      + ' must be one bare UUID with no comma, Chinese punctuation, module name, or path',
    );
  }
}

function assertUniqueModule(modules, id, field) {
  const matches = modules.filter((module) => module.id === id);
  if (matches.length === 0) {
    throw new Error('[validation_error] ' + field + ' was not found in the MeterSphere module tree: ' + id);
  }
  if (matches.length > 1) {
    throw new Error('[tree_conflict] ' + field + ' appears in more than one tree position: ' + id);
  }
  return matches[0];
}

function resultFor(module, parent, flags) {
  return [{ json: {
    id: module.id,
    module_id: module.id,
    name: module.name,
    parent_id: module.parentId,
    parent_path: parent.path,
    path: module.path,
    level: module.level,
    operation: flags.operation,
    created: flags.created,
    updated: flags.updated,
    reused: flags.reused,
    verified: true,
    message: flags.message,
  } }];
}

const request = $input.first().json;
const moduleId = String(request.module_id ?? '').trim();
const name = String(request.name ?? '').trim();
const parentId = String(request.parent_id ?? '').trim();

if (moduleId) assertUuid(moduleId, 'module_id');
if (!name) throw new Error('[validation_error] name is required');
if (name.length > 255) throw new Error('[validation_error] name must not exceed 255 characters');
if (name.includes('/')) {
  throw new Error('[validation_error] name must not contain / because module paths use / as a separator');
}
if (!parentId) {
  throw new Error('[validation_error] parent_id is required; use the exact module UUID from ms_list_modules');
}
assertUuid(parentId, 'parent_id');

const beforeTree = await readModuleTree();
const beforeModules = flattenModules(beforeTree);
const parent = assertUniqueModule(beforeModules, parentId, 'parent_id');
const level = 2;
const expectedPath = parent.path + '/' + name;

if (moduleId) {
  const existing = assertUniqueModule(beforeModules, moduleId, 'module_id');
  if (moduleId === parentId || parent.ancestorIds.includes(moduleId)) {
    throw new Error('[validation_error] a module cannot be moved under itself or one of its descendants');
  }

  const conflictingSiblings = beforeModules.filter((module) =>
    module.parentId === parentId && module.name === name && module.id !== moduleId,
  );
  if (conflictingSiblings.length > 0) {
    throw new Error('[tree_conflict] another sibling already has the requested name: ' + expectedPath);
  }

  const unchanged = existing.parentId === parentId
    && existing.name === name
    && existing.path === expectedPath
    && existing.level === level;

  if (!unchanged) {
    const editBody = {
      nodeIds: [moduleId],
      type: 'edit',
      id: moduleId,
      level,
      parentId,
      name,
      label: name,
      projectId,
    };
    const editResponse = await helpers.httpRequest({
      method: 'POST',
      url: baseUrl + '/track/case/node/edit',
      headers: requestHeaders(),
      body: editBody,
      json: true,
    });
    parseEnvelope(editResponse, 'module edit');
  }

  const afterModules = unchanged ? beforeModules : flattenModules(await readModuleTree());
  const updatedModule = assertUniqueModule(afterModules, moduleId, 'updated module_id');
  const finalSiblings = afterModules.filter((module) =>
    module.parentId === parentId && module.name === name,
  );
  if (
    updatedModule.parentId !== parentId
    || updatedModule.name !== name
    || updatedModule.path !== expectedPath
    || updatedModule.level !== level
    || finalSiblings.length !== 1
    || finalSiblings[0].id !== moduleId
  ) {
    throw new Error(
      '[postcondition_error] Updated module failed tree verification. Expected id=' + moduleId
      + ', parent_id=' + parentId + ', path=' + expectedPath + ', level=' + level
      + '; actual parent_id=' + updatedModule.parentId + ', path=' + updatedModule.path
      + ', level=' + updatedModule.level + ', matching_siblings=' + finalSiblings.length,
    );
  }

  return resultFor(updatedModule, parent, {
    operation: 'update',
    created: false,
    updated: !unchanged,
    reused: unchanged,
    message: unchanged
      ? 'Module already matched the requested name and parent; no edit was needed'
      : 'Module updated and unique tree placement verified',
  });
}

const existingSiblings = beforeModules.filter((module) =>
  module.parentId === parentId && module.name === name,
);
if (existingSiblings.length > 1) {
  throw new Error('[tree_conflict] more than one sibling already has the requested name: ' + expectedPath);
}
if (existingSiblings.length === 1) {
  const existing = assertUniqueModule(beforeModules, existingSiblings[0].id, 'existing module');
  if (existing.path !== expectedPath || existing.level !== level) {
    throw new Error('[tree_conflict] the existing module has inconsistent tree metadata: ' + existing.id);
  }
  return resultFor(existing, parent, {
    operation: 'create',
    created: false,
    updated: false,
    reused: true,
    message: 'Module already existed under the requested parent; reused after tree verification',
  });
}

const createBody = {
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
  body: createBody,
  json: true,
});
const createdData = parseEnvelope(createResponse, 'module create');
const createdId = typeof createdData === 'string' ? createdData : createdData?.id;
if (!createdId) throw new Error('[postcondition_error] MeterSphere create succeeded without a module id');

const afterModules = flattenModules(await readModuleTree());
const createdModule = assertUniqueModule(afterModules, createdId, 'created module');
const finalSiblings = afterModules.filter((module) =>
  module.parentId === parentId && module.name === name,
);
if (
  createdModule.parentId !== parentId
  || createdModule.path !== expectedPath
  || createdModule.level !== level
  || finalSiblings.length !== 1
  || finalSiblings[0].id !== createdId
) {
  throw new Error(
    '[postcondition_error] Created module failed tree verification. Expected id=' + createdId
    + ', parent_id=' + parentId + ', path=' + expectedPath + ', level=' + level
    + '; actual parent_id=' + createdModule.parentId + ', path=' + createdModule.path
    + ', level=' + createdModule.level + ', matching_siblings=' + finalSiblings.length,
  );
}

return resultFor(createdModule, parent, {
  operation: 'create',
  created: true,
  updated: false,
  reused: false,
  message: 'Module created and unique tree placement verified',
});
`;

upsertNode.name = 'Upsert Module';
upsertNode.parameters.jsCode = configuration + implementation;
upsertNode.retryOnFail = true;
upsertNode.maxTries = 3;
upsertNode.waitBetweenTries = 5000;

workflow.connections = {
  [trigger.name]: {
    main: [[{ node: upsertNode.name, type: 'main', index: 0 }]],
  },
};
workflow.name = 'ms_upsert_module';
workflow.description = 'Create, reuse, rename, or move one MeterSphere module. Inputs: optional module_id plus required name and parent_id. Omitting module_id preserves idempotent create behavior; providing it performs an edit and verifies unique tree placement.';

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
  description: workflow.description,
}));
