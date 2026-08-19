const crypto = require('crypto');

/*__MS_CONFIG__*/

const MAX_ITEMS = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set([
  'operation', 'case_id', 'name', 'node_id', 'node_path', 'priority', 'maintainer',
  'status', 'prerequisite', 'step_model', 'step_description', 'expected_result',
  'steps', 'tags', 'remark',
]);
const MUTABLE_UPDATE_KEYS = [
  'name', 'node_id', 'node_path', 'priority', 'maintainer', 'status', 'prerequisite',
  'step_model', 'step_description', 'expected_result', 'steps', 'remark',
];

function validationError(message) {
  throw new Error('[validation_error] ' + message);
}

function parseJsonArray(value, fieldName) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) {
    validationError(fieldName + ' must be a non-empty JSON array string');
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) validationError(fieldName + ' must decode to an array');
    return parsed;
  } catch (error) {
    if (String(error.message).startsWith('[validation_error]')) throw error;
    validationError(fieldName + ' must be valid JSON: ' + error.message);
  }
}

function normalizePath(value) {
  const path = String(value ?? '').trim().replace(/\\+/g, '/').replace(/\/$/, '');
  if (!path) return '';
  return path.startsWith('/') ? path : '/' + path;
}

function normalizeSteps(value, fieldName) {
  const steps = value === undefined ? undefined : parseJsonArray(value, fieldName);
  if (steps === undefined) return undefined;
  if (steps.length > 100) validationError(fieldName + ' supports at most 100 steps');
  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      validationError(fieldName + '[' + index + '] must be an object');
    }
    const desc = String(step.desc ?? '');
    const result = String(step.result ?? '');
    if (desc.length > 10000 || result.length > 10000) {
      validationError(fieldName + '[' + index + '] desc/result must not exceed 10000 characters');
    }
    return {
      id: step.id || crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      num: Number.isFinite(Number(step.num)) ? Number(step.num) : index + 1,
      desc,
      result,
    };
  });
}

function normalizeTags(value, fieldName) {
  const tags = value === undefined ? undefined : parseJsonArray(value, fieldName);
  if (tags === undefined) return undefined;
  const normalized = [...new Set(tags.map((tag, index) => {
    if (typeof tag !== 'string' || !tag.trim()) {
      validationError(fieldName + '[' + index + '] must be a non-empty string');
    }
    const value = tag.trim();
    if (value.length > 50) validationError(fieldName + '[' + index + '] must not exceed 50 characters');
    return value;
  }))];
  if (normalized.length > 20) validationError(fieldName + ' supports at most 20 tags');
  return normalized;
}

function requestHeaders() {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const plaintext = `${accessKey}|${nonce}|${timestamp}`;
  const key = Buffer.from(secretKey.slice(0, 16), 'utf8');
  const iv = Buffer.from(accessKey.slice(0, 16), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const signature = cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64');
  return {
    ACCEPT: 'application/json',
    'Content-Type': 'application/json',
    accessKey,
    signature,
    project: projectId,
    workspace: workspaceId,
  };
}

async function msRequest(method, path, body) {
  let response;
  try {
    response = await helpers.httpRequest({
      method,
      url: baseUrl + path,
      headers: requestHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      json: true,
    });
  } catch (error) {
    throw new Error('[upstream_error] MeterSphere request failed: ' + error.message);
  }
  const envelope = typeof response === 'string' && response ? JSON.parse(response) : response;
  if (envelope && envelope.success === false) {
    throw new Error('[upstream_error] MeterSphere rejected the request: ' + envelope.message);
  }
  return envelope ? envelope.data : undefined;
}

async function mapWithConcurrency(values, limit, fn) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function getCase(caseId) {
  const detail = await msRequest('GET', '/track/test/case/get/' + encodeURIComponent(caseId));
  if (!detail) throw new Error('[upstream_error] MeterSphere returned no detail for case ' + caseId);
  if (detail.projectId !== projectId) validationError('case ' + caseId + ' belongs to another project');
  if (String(detail.status).toLowerCase() === 'trash') validationError('case ' + caseId + ' is in the recycle bin');
  return detail;
}

function flattenModules(nodes, parentPath = '', output = []) {
  for (const node of nodes || []) {
    const path = parentPath ? parentPath + '/' + node.name : '/' + node.name;
    const children = Array.isArray(node.children) ? node.children : [];
    output.push({ id: node.id, path, childCount: children.length });
    flattenModules(children, path, output);
  }
  return output;
}

function resolveModule(item, index, moduleById, moduleByPath, existing) {
  const hasId = Object.prototype.hasOwnProperty.call(item, 'node_id');
  const hasPath = Object.prototype.hasOwnProperty.call(item, 'node_path');
  if (hasId !== hasPath) {
    validationError('items[' + index + '] node_id and node_path must be supplied together');
  }
  if (!hasId) {
    if (!existing) validationError('items[' + index + '] create requires node_id and node_path');
    return { id: existing.nodeId, path: normalizePath(existing.nodePath) };
  }
  const nodeId = String(item.node_id || '').trim();
  const nodePath = normalizePath(item.node_path);
  if (!UUID_PATTERN.test(nodeId)) validationError('items[' + index + '] has an invalid node_id UUID');
  const byId = moduleById.get(nodeId);
  const byPath = moduleByPath.get(nodePath);
  if (!byId) validationError('items[' + index + '] node_id was not found: ' + nodeId);
  if (!byPath) validationError('items[' + index + '] node_path was not found: ' + nodePath);
  if (byId.id !== byPath.id) validationError('items[' + index + '] node_id and node_path identify different modules');
  if (byId.childCount > 0) validationError('items[' + index + '] target module is not a leaf: ' + nodePath);
  return { id: byId.id, path: byId.path };
}

function parseStoredArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const input = $input.first().json;
const rawItems = parseJsonArray(input.items, 'items');
if (rawItems.length === 0) validationError('items must contain at least one operation');
if (rawItems.length > MAX_ITEMS) validationError('items supports at most ' + MAX_ITEMS + ' operations per call');

const normalizedInputs = rawItems.map((rawItem, index) => {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    validationError('items[' + index + '] must be an object');
  }
  const unknownKeys = Object.keys(rawItem).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    validationError('items[' + index + '] contains unsupported fields: ' + unknownKeys.join(', '));
  }
  const operation = String(rawItem.operation || '').trim().toLowerCase();
  if (!['create', 'update'].includes(operation)) {
    validationError('items[' + index + '].operation must be create or update');
  }
  if (operation === 'create' && Object.prototype.hasOwnProperty.call(rawItem, 'case_id')) {
    validationError('items[' + index + '] create must not supply case_id');
  }
  if (operation === 'update') {
    const caseId = String(rawItem.case_id || '').trim();
    if (!UUID_PATTERN.test(caseId)) validationError('items[' + index + '] update requires a valid case_id UUID');
    if (Object.prototype.hasOwnProperty.call(rawItem, 'tags')) {
      validationError('items[' + index + '] cannot update tags through minder/edit; use ms_batch_edit_test_cases');
    }
    if (!MUTABLE_UPDATE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(rawItem, key))) {
      validationError('items[' + index + '] update must contain at least one mutable field');
    }
  }
  if (rawItem.name !== undefined) {
    const name = String(rawItem.name).trim();
    if (!name) validationError('items[' + index + '].name must not be blank');
    if (name.length > 255) validationError('items[' + index + '].name must not exceed 255 characters');
  }
  if (operation === 'create' && !String(rawItem.name || '').trim()) {
    validationError('items[' + index + '] create requires name');
  }
  if (rawItem.priority !== undefined && !['P0', 'P1', 'P2', 'P3'].includes(String(rawItem.priority))) {
    validationError('items[' + index + '].priority must be P0, P1, P2, or P3');
  }
  if (rawItem.maintainer !== undefined) {
    const maintainer = String(rawItem.maintainer).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(maintainer)) {
      validationError('items[' + index + '].maintainer must be a MeterSphere account email');
    }
  }
  if (rawItem.status !== undefined && (!String(rawItem.status).trim() || String(rawItem.status).length > 64)) {
    validationError('items[' + index + '].status must be 1-64 characters');
  }
  return {
    ...rawItem,
    operation,
    case_id: operation === 'update' ? String(rawItem.case_id).trim() : undefined,
    steps: normalizeSteps(rawItem.steps, 'items[' + index + '].steps'),
    tags: normalizeTags(rawItem.tags, 'items[' + index + '].tags'),
  };
});

const updateIds = normalizedInputs.filter((item) => item.operation === 'update').map((item) => item.case_id);
if (new Set(updateIds).size !== updateIds.length) validationError('the same case_id cannot be updated twice in one batch');

const [moduleTree, existingCases] = await Promise.all([
  msRequest('GET', '/track/case/node/list/' + projectId),
  mapWithConcurrency(updateIds, 5, getCase),
]);
const modules = flattenModules(moduleTree);
const moduleById = new Map(modules.map((module) => [module.id, module]));
const moduleByPath = new Map(modules.map((module) => [module.path, module]));
const existingById = new Map(existingCases.map((testCase) => [testCase.id, testCase]));

const expectedChecks = [];
const minderItems = normalizedInputs.map((item, index) => {
  const existing = item.operation === 'update' ? existingById.get(item.case_id) : null;
  const module = resolveModule(item, index, moduleById, moduleByPath, existing);
  const id = existing ? existing.id : crypto.randomUUID();
  const name = item.name !== undefined ? String(item.name).trim() : existing.name;
  const priority = item.priority !== undefined ? String(item.priority) : (existing?.priority || 'P2');
  const maintainer = item.maintainer !== undefined ? String(item.maintainer).trim() : (existing?.maintainer || 'jiabowang@moego.pet');
  const status = item.status !== undefined ? String(item.status).trim() : (existing?.status || 'Prepare');
  const steps = item.steps !== undefined ? item.steps : parseStoredArray(existing?.steps);
  const tags = item.tags !== undefined ? item.tags : parseStoredArray(existing?.tags);
  const minderItem = {
    id,
    isEdit: item.operation === 'update',
    name,
    nodeId: module.id,
    nodePath: module.path,
    priority,
    maintainer,
    status,
    type: existing?.type || 'functional',
    method: existing?.method || '',
    prerequisite: item.prerequisite !== undefined ? String(item.prerequisite) : (existing?.prerequisite || ''),
    testId: existing?.testId || '[]',
    steps: JSON.stringify(steps),
    stepDesc: existing?.stepDesc || '',
    stepResult: existing?.stepResult || '',
    selected: [],
    remark: item.remark !== undefined ? String(item.remark) : (existing?.remark || ''),
    tags: JSON.stringify(tags),
    demandId: existing?.demandId || '',
    demandName: existing?.demandName || '',
    reviewStatus: existing?.reviewStatus || 'Prepare',
    stepDescription: item.step_description !== undefined ? String(item.step_description) : (existing?.stepDescription || ''),
    expectedResult: item.expected_result !== undefined ? String(item.expected_result) : (existing?.expectedResult || ''),
    stepModel: item.step_model !== undefined ? String(item.step_model) : (existing?.stepModel || 'STEP'),
    casePublic: existing?.casePublic || false,
    refId: existing?.refId,
    versionId: existing?.versionId,
    latest: existing?.latest,
    num: existing?.num,
    customNum: existing?.customNum,
  };
  expectedChecks.push({
    operation: item.operation,
    id,
    requested: item,
    expected: {
      name,
      nodeId: module.id,
      nodePath: module.path,
      priority,
      maintainer,
      status,
      prerequisite: minderItem.prerequisite,
      steps: minderItem.steps,
      remark: minderItem.remark,
      stepDescription: minderItem.stepDescription,
      expectedResult: minderItem.expectedResult,
      stepModel: minderItem.stepModel,
      tags: minderItem.tags,
    },
  });
  return minderItem;
});

const requestBody = {
  projectId,
  ids: [],
  data: minderItems,
  testCaseNodes: [],
  extraNodeRequest: {
    groupId: projectId,
    type: 'TEST_CASE',
    data: {},
  },
};

if (input.dry_run === true) {
  return [{ json: {
    success: true,
    dry_run: true,
    validated: true,
    item_count: minderItems.length,
    creates: expectedChecks.filter((item) => item.operation === 'create').map((item) => ({ id: item.id, name: item.expected.name, priority: item.expected.priority, node_id: item.expected.nodeId, node_path: item.expected.nodePath })),
    updates: expectedChecks.filter((item) => item.operation === 'update').map((item) => ({ id: item.id, name: item.expected.name, priority: item.expected.priority, node_id: item.expected.nodeId, node_path: item.expected.nodePath })),
    deletion_ids_forced_empty: true,
    message: 'Validation, module resolution, and update preflight passed; no cases were changed',
  } }];
}

await msRequest('POST', '/track/test/case/minder/edit', requestBody);
const afterCases = await mapWithConcurrency(expectedChecks, 5, (check) => getCase(check.id));

const results = afterCases.map((actual, index) => {
  const check = expectedChecks[index];
  const fieldsToVerify = check.operation === 'create'
    ? ['name', 'nodeId', 'nodePath', 'priority', 'maintainer', 'status', 'prerequisite', 'steps', 'tags', 'remark', 'stepDescription', 'expectedResult', 'stepModel']
    : MUTABLE_UPDATE_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(check.requested, key))
      .flatMap((key) => key === 'node_id' || key === 'node_path' ? ['nodeId', 'nodePath'] : ({
        step_description: ['stepDescription'],
        expected_result: ['expectedResult'],
        step_model: ['stepModel'],
      }[key] || [key]));
  const uniqueFields = [...new Set(fieldsToVerify)];
  const mismatches = uniqueFields.filter((field) => {
    const expected = check.expected[field];
    const observed = actual[field];
    if (field === 'steps' || field === 'tags') {
      return JSON.stringify(parseStoredArray(observed)) !== JSON.stringify(parseStoredArray(expected));
    }
    if (field === 'nodePath') return normalizePath(observed) !== normalizePath(expected);
    return observed !== expected;
  });
  return {
    operation: check.operation,
    id: actual.id,
    num: actual.num,
    name: actual.name,
    priority: actual.priority,
    node_id: actual.nodeId,
    node_path: normalizePath(actual.nodePath),
    verified: mismatches.length === 0,
    mismatches,
  };
});

const failed = results.filter((result) => !result.verified);
if (failed.length > 0) {
  throw new Error('[postcondition_error] MeterSphere returned success, but verification failed for: ' + failed.map((item) => item.id + ' (' + item.mismatches.join(', ') + ')').join('; '));
}

return [{ json: {
  success: true,
  dry_run: false,
  item_count: results.length,
  created_count: results.filter((item) => item.operation === 'create').length,
  updated_count: results.filter((item) => item.operation === 'update').length,
  deletion_ids_forced_empty: true,
  results,
  message: 'Bulk create/update completed and every case was verified',
} }];
