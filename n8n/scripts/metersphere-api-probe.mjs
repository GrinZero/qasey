import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const [command, argument, modulePath, requestedMaintainer, rangeEnd] = process.argv.slice(2);

if (!command) {
  throw new Error('Usage: node scripts/metersphere-api-probe.mjs <detail|list|modules-stats|repair-module|create> [argument]');
}

const workflow = JSON.parse(
  execFileSync('n8n-cli', ['workflow', 'get', 'hcgRlma0buIb11S2', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);

const source = workflow.nodes.find((node) => node.name === 'Create Test Case')?.parameters?.jsCode;
if (!source) throw new Error('Create Test Case workflow source was not found');

function readConstant(name) {
  const match = source.match(new RegExp(`const ${name} = '([^']+)'`));
  if (!match) throw new Error(`Unable to read ${name} from the workflow`);
  return match[1];
}

const accessKey = readConstant('accessKey');
const secretKey = readConstant('secretKey');
const baseUrl = readConstant('baseUrl');
const projectId = readConstant('projectId');
const workspaceId = readConstant('workspaceId');

function requestHeaders(contentType = 'application/json') {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const plaintext = `${accessKey}|${nonce}|${timestamp}`;
  const key = Buffer.from(secretKey.slice(0, 16), 'utf8');
  const iv = Buffer.from(accessKey.slice(0, 16), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const signature = cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64');

  return {
    ACCEPT: 'application/json',
    'Content-Type': contentType,
    accessKey,
    signature,
    project: projectId,
    workspace: workspaceId,
  };
}

async function parseResponse(response) {
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(`MeterSphere ${response.status}: ${data.message ?? 'request failed'}`);
  }
  return data.data;
}

async function getCaseDetail(caseId) {
  const response = await fetch(`${baseUrl}/track/test/case/get/${caseId}`, {
    headers: requestHeaders(),
  });
  return parseResponse(response);
}

async function resolveNodeByPath(targetNodePath) {
  const response = await fetch(`${baseUrl}/track/case/node/list/${projectId}`, {
    headers: requestHeaders(),
  });
  const nodes = await parseResponse(response);

  function find(items, parents) {
    for (const node of items || []) {
      const names = [...parents, node.name];
      const nodePath = `/${names.join('/')}`;
      if (nodePath === targetNodePath) return { id: node.id, path: nodePath };
      const child = find(node.children, names);
      if (child) return child;
    }
    return null;
  }

  const resolved = find(nodes, []);
  if (!resolved) throw new Error(`Module path was not found: ${targetNodePath}`);
  return resolved;
}

function parseArrayField(value, fieldName) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string or array`);
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  if (fieldName === 'tags') return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  throw new Error(`${fieldName} is not a JSON array string`);
}

function buildRebuiltCase(original, targetNodePath, targetNodeId, maintainer) {
  if (!targetNodePath) throw new Error('prepare/clone requires a module path');
  const steps = parseArrayField(original.steps, 'steps').map((step, index) => ({
    ...step,
    id: step.id || crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    num: step.num ?? index + 1,
  }));
  const tags = parseArrayField(original.tags, 'tags');
  const priority = original.priority || 'P2';
  const status = original.status || 'Prepare';

  return {
    name: original.name,
    num: '',
    nodePath: targetNodePath,
    maintainer,
    priority,
    type: 'functional',
    method: original.method || '',
    prerequisite: original.prerequisite || '',
    testId: original.testId || '[]',
    nodeId: targetNodeId,
    steps: JSON.stringify(steps),
    stepDesc: '',
    stepResult: '',
    selected: [],
    remark: original.remark || '',
    tags: JSON.stringify(tags),
    demandId: original.demandId || '',
    demandName: original.demandName || '',
    status,
    reviewStatus: original.reviewStatus || 'Prepare',
    stepDescription: original.stepDescription || '',
    expectedResult: original.expectedResult || '',
    stepModel: original.stepModel || null,
    customNum: '',
    followPeople: '',
    versionId: original.versionId || '',
    fields: [],
    id: null,
    projectId,
    casePublic: false,
    addFields: [
      { fieldId: '46065143-9d1d-11eb-b418-0242ac120002', value: JSON.stringify(maintainer) },
      { fieldId: '4619cc23-9d1d-11eb-b418-0242ac120002', value: JSON.stringify(priority) },
      { fieldId: '45f2de57-9d1d-11eb-b418-0242ac120002', value: JSON.stringify(status) },
    ],
    editFields: [],
    requestFields: [
      { id: '46065143-9d1d-11eb-b418-0242ac120002', name: '责任人', customData: null, type: 'member', value: maintainer },
      { id: '4619cc23-9d1d-11eb-b418-0242ac120002', name: '用例等级', customData: null, type: 'select', value: priority },
      { id: '45f2de57-9d1d-11eb-b418-0242ac120002', name: '用例状态', customData: null, type: 'select', value: status },
    ],
  };
}

function buildRelocatedCase(original, targetNodePath, targetNodeId, maintainer) {
  const body = buildRebuiltCase(original, targetNodePath, targetNodeId, maintainer);
  body.id = original.id;
  body.refId = original.id;
  body.latest = true;
  body.copyCaseId = original.id;
  body.follows = [];
  body.versionId = original.versionId || '3570d801-19aa-11ee-a261-5a66b98c4036';
  body.addFields = [];
  body.editFields = body.requestFields.map(({ id, value }) => ({
    fieldId: id,
    value: JSON.stringify(value),
  }));
  body.fields = body.requestFields.map(({ id, value }) => ({ id, value }));
  return body;
}

if (command === 'detail') {
  if (!argument) throw new Error('detail requires a case id');
  process.stdout.write(`${JSON.stringify(await getCaseDetail(argument), null, 2)}\n`);
} else if (command === 'modules-stats') {
  const response = await fetch(`${baseUrl}/track/case/node/list/${projectId}`, {
    headers: requestHeaders(),
  });
  const raw = await response.text();
  const envelope = JSON.parse(raw);
  if (!response.ok || !envelope.success) {
    throw new Error(`MeterSphere ${response.status}: ${envelope.message ?? 'request failed'}`);
  }

  let nodeCount = 0;
  const flattened = [];
  function walk(nodes, parentPath = '') {
    for (const node of nodes || []) {
      nodeCount += 1;
      const path = parentPath ? `${parentPath}/${node.name}` : node.name;
      flattened.push({
        id: node.id,
        name: node.name,
        path,
        level: node.level,
        parent_id: node.parentId || null,
      });
      walk(node.children, path);
    }
  }
  walk(envelope.data);

  process.stdout.write(`${JSON.stringify({
    node_count: nodeCount,
    upstream_bytes: Buffer.byteLength(raw),
    current_flattened_output_bytes: Buffer.byteLength(JSON.stringify({ modules: flattened })),
    root_count: Array.isArray(envelope.data) ? envelope.data.length : 0,
  }, null, 2)}\n`);
} else if (command === 'repair-module') {
  if (!argument || !modulePath || !requestedMaintainer) {
    throw new Error('repair-module requires module id, module name, and parent module id');
  }

  const treeResponse = await fetch(`${baseUrl}/track/case/node/list/${projectId}`, {
    headers: requestHeaders(),
  });
  const tree = await parseResponse(treeResponse);

  function findNode(nodes, id) {
    for (const node of nodes || []) {
      if (node.id === id) return node;
      const child = findNode(node.children, id);
      if (child) return child;
    }
    return null;
  }

  const parent = findNode(tree, requestedMaintainer);
  if (!parent) throw new Error(`Parent module was not found: ${requestedMaintainer}`);
  const parentLevel = Number(parent.level);
  if (!Number.isInteger(parentLevel) || parentLevel < 1) {
    throw new Error(`Parent module has an invalid level: ${parent.level}`);
  }

  const body = {
    id: argument,
    name: modulePath,
    projectId,
    parentId: parent.id,
    level: parentLevel + 1,
    nodeTree: parent,
    nodeIds: [argument],
  };
  const repairResponse = await fetch(`${baseUrl}/track/case/node/drag`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify(body),
  });
  await parseResponse(repairResponse);

  const verifyResponse = await fetch(`${baseUrl}/track/case/node/list/${projectId}`, {
    headers: requestHeaders(),
  });
  const verifiedTree = await parseResponse(verifyResponse);
  const matches = [];
  function collect(nodes, parentPath = '') {
    for (const node of nodes || []) {
      const path = `${parentPath}/${node.name}`;
      if (node.id === argument) {
        matches.push({
          id: node.id,
          name: node.name,
          path,
          parent_id: node.parentId || null,
          level: node.level,
        });
      }
      collect(node.children, path);
    }
  }
  collect(verifiedTree);
  process.stdout.write(`${JSON.stringify({
    success: matches.length === 1
      && matches[0].parent_id === parent.id
      && Number(matches[0].level) === parentLevel + 1,
    requested: {
      id: argument,
      parent_id: parent.id,
      level: parentLevel + 1,
    },
    matches,
  }, null, 2)}\n`);
} else if (command === 'list') {
  if (!argument) throw new Error('list requires a module id');
  const response = await fetch(`${baseUrl}/track/test/case/list/1/100`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({ projectId, nodeIds: [argument] }),
  });
  process.stdout.write(`${JSON.stringify(await parseResponse(response), null, 2)}\n`);
} else if (command === 'validate') {
  if (!argument || !modulePath || !requestedMaintainer) {
    throw new Error('validate requires a module id, module path, minimum case number, and optional maximum case number');
  }
  const minNum = Number(requestedMaintainer);
  const maxNum = rangeEnd ? Number(rangeEnd) : Number.POSITIVE_INFINITY;
  const response = await fetch(`${baseUrl}/track/test/case/list/1/100`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({ projectId, nodeIds: [argument] }),
  });
  const listed = await parseResponse(response);
  const cases = listed.listObject
    .filter((item) => item.num >= minNum && item.num <= maxNum)
    .sort((left, right) => left.num - right.num);
  const issues = [];
  for (const listedCase of cases) {
    const detail = await getCaseDetail(listedCase.id);
    let tags;
    let steps;
    try {
      tags = JSON.parse(detail.tags);
      steps = JSON.parse(detail.steps);
    } catch (error) {
      issues.push({ num: detail.num, field: 'json', message: error.message });
      continue;
    }
    const valid = detail.nodePath === modulePath
      && detail.maintainer === 'jiabowang@moego.pet'
      && Array.isArray(tags)
      && Array.isArray(steps)
      && steps.length > 0
      && steps.every((step) => typeof step.id === 'string' && step.id.length === 8);
    if (!valid) issues.push({ num: detail.num, field: 'structure' });
  }
  process.stdout.write(`${JSON.stringify({ validated: cases.length - issues.length, total: cases.length, issues }, null, 2)}\n`);
  if (issues.length) process.exitCode = 1;
} else if (command === 'prepare' || command === 'clone' || command === 'relocate') {
  if (!argument) throw new Error(`${command} requires a source case id`);
  const maintainer = requestedMaintainer || 'jiabowang@moego.pet';
  const targetNode = await resolveNodeByPath(modulePath);
  const original = await getCaseDetail(argument);
  const body = command === 'relocate'
    ? buildRelocatedCase(original, targetNode.path, targetNode.id, maintainer)
    : buildRebuiltCase(original, targetNode.path, targetNode.id, maintainer);
  if (command === 'prepare') {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify(body)], { type: 'application/json' }), 'blob');
    const headers = requestHeaders();
    delete headers['Content-Type'];
    const endpoint = command === 'relocate' ? 'edit' : 'add';
    const response = await fetch(`${baseUrl}/track/test/case/${endpoint}`, {
      method: 'POST',
      headers,
      body: form,
    });
    process.stdout.write(`${JSON.stringify(await parseResponse(response), null, 2)}\n`);
  }
} else if (command === 'create') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) throw new Error('create requires a JSON body on stdin');

  const form = new FormData();
  form.append('request', new Blob([input], { type: 'application/json' }), 'blob');
  const headers = requestHeaders();
  delete headers['Content-Type'];

  const response = await fetch(`${baseUrl}/track/test/case/add`, {
    method: 'POST',
    headers,
    body: form,
  });
  process.stdout.write(`${JSON.stringify(await parseResponse(response), null, 2)}\n`);
} else {
  throw new Error(`Unsupported command: ${command}`);
}
