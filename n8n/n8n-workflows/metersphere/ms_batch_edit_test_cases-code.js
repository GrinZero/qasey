const crypto = require('crypto');

/*__MS_CONFIG__*/

const MAX_CASES = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYSTEM_FIELDS = {
  priority: { fieldId: '4619cc23-9d1d-11eb-b418-0242ac120002', name: '用例等级' },
  status: { fieldId: '45f2de57-9d1d-11eb-b418-0242ac120002', name: '用例状态' },
  maintainer: { fieldId: '46065143-9d1d-11eb-b418-0242ac120002', name: '责任人' },
};

function validationError(message) {
  throw new Error('[validation_error] ' + message);
}

function parseArray(value, fieldName) {
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

function uniqueStrings(values, fieldName) {
  const normalized = values.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      validationError(fieldName + '[' + index + '] must be a non-empty string');
    }
    return value.trim();
  });
  return [...new Set(normalized)];
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
  if (detail.projectId !== projectId) {
    validationError('case ' + caseId + ' does not belong to the configured project');
  }
  if (String(detail.status).toLowerCase() === 'trash') {
    validationError('case ' + caseId + ' is in the recycle bin');
  }
  return detail;
}

const input = $input.first().json;
const ids = uniqueStrings(parseArray(input.case_ids, 'case_ids'), 'case_ids');
if (ids.length === 0) validationError('case_ids must contain at least one id');
if (ids.length > MAX_CASES) validationError('case_ids supports at most ' + MAX_CASES + ' cases per call');
for (const id of ids) {
  if (!UUID_PATTERN.test(id)) validationError('invalid case UUID: ' + id);
}

const field = String(input.field || '').trim();
if (!['priority', 'status', 'maintainer', 'tags'].includes(field)) {
  validationError('field must be one of priority, status, maintainer, tags');
}

let normalizedValue;
let tagMode = 'replace';
if (field === 'tags') {
  normalizedValue = uniqueStrings(parseArray(input.value, 'value'), 'value');
  if (normalizedValue.length === 0) validationError('tags must contain at least one tag');
  if (normalizedValue.length > 20) validationError('at most 20 tags may be supplied');
  normalizedValue.forEach((tag) => {
    if (tag.length > 50) validationError('tag must not exceed 50 characters: ' + tag);
  });
  tagMode = String(input.tag_mode || 'replace').trim().toLowerCase();
  if (!['replace', 'append'].includes(tagMode)) {
    validationError('tag_mode must be replace or append');
  }
} else {
  normalizedValue = String(input.value ?? '').trim();
  if (!normalizedValue) validationError('value is required');
  if (field === 'priority' && !['P0', 'P1', 'P2', 'P3'].includes(normalizedValue)) {
    validationError('priority must be one of P0, P1, P2, P3');
  }
  if (field === 'status' && normalizedValue.length > 64) {
    validationError('status must not exceed 64 characters');
  }
  if (field === 'maintainer') {
    if (normalizedValue.length > 255) validationError('maintainer must not exceed 255 characters');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedValue)) {
      validationError('maintainer must be a MeterSphere account email');
    }
  }
}

const beforeCases = await mapWithConcurrency(ids, 5, getCase);
const requestBody = {
  ids,
  condition: {
    projectId,
    ids,
    selectAll: false,
  },
};

if (field === 'tags') {
  requestBody.type = 'tags';
  requestBody.tagList = normalizedValue;
  requestBody.appendTag = tagMode === 'append';
} else {
  requestBody.customField = {
    fieldId: SYSTEM_FIELDS[field].fieldId,
    name: SYSTEM_FIELDS[field].name,
    value: JSON.stringify(normalizedValue),
  };
}

if (input.dry_run === true) {
  return [{ json: {
    success: true,
    dry_run: true,
    validated: true,
    case_count: ids.length,
    case_ids: ids,
    field,
    value: normalizedValue,
    tag_mode: field === 'tags' ? tagMode : null,
    message: 'Validation and case preflight passed; no cases were changed',
  } }];
}

await msRequest('POST', '/track/test/case/batch/edit', requestBody);
const afterCases = await mapWithConcurrency(ids, 5, getCase);

const results = afterCases.map((after, index) => {
  const before = beforeCases[index];
  let actual;
  let verified;
  if (field === 'tags') {
    actual = Array.isArray(after.tags) ? after.tags : JSON.parse(after.tags || '[]');
    verified = normalizedValue.every((tag) => actual.includes(tag));
    if (tagMode === 'replace') {
      verified = verified && actual.length === normalizedValue.length;
    }
  } else {
    actual = after[field];
    verified = actual === normalizedValue;
  }
  return {
    id: after.id,
    name: after.name,
    before: field === 'tags' ? before.tags : before[field],
    after: actual,
    verified,
  };
});

const failed = results.filter((result) => !result.verified);
if (failed.length > 0) {
  throw new Error('[postcondition_error] MeterSphere returned success, but verification failed for: ' + failed.map((item) => item.id).join(', '));
}

return [{ json: {
  success: true,
  dry_run: false,
  updated_count: results.length,
  field,
  value: normalizedValue,
  tag_mode: field === 'tags' ? tagMode : null,
  results,
  message: 'Batch update completed and every case was verified',
} }];
