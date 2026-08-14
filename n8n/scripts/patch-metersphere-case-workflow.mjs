import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

const workflow = JSON.parse(input);

const helper = String.raw`
function normalizeArrayField(value, fieldName, fallback) {
  if (value === undefined || value === null || value === '') {
    return JSON.stringify(fallback);
  }

  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return JSON.stringify(fallback);

    if (trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(fieldName + ' must be valid JSON: ' + error.message);
      }
    } else {
      const example = fieldName === 'tags'
        ? '["回归","P0"]'
        : '[{"num":1,"desc":"操作步骤","result":"预期结果"}]';
      throw new Error(fieldName + ' must be a JSON array string, for example: ' + example);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error(fieldName + ' must be an array');
  }

  if (fieldName === 'tags') {
    parsed = parsed.map((tag) => String(tag).trim()).filter(Boolean);
  } else if (fieldName === 'steps') {
    parsed = parsed.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error('steps[' + index + '] must be an object');
      }
      return {
        ...step,
        id: step.id || crypto.randomUUID().replace(/-/g, '').slice(0, 8),
        num: Number.isFinite(Number(step.num)) ? Number(step.num) : index + 1,
        desc: String(step.desc ?? ''),
        result: String(step.result ?? ''),
      };
    });
  }

  return JSON.stringify(parsed);
}
`;

const nodePathResolver = String.raw`
async function resolveNodePath(nodeId) {
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
  if (!data.success) throw new Error('Unable to resolve module path: ' + data.message);

  function find(nodes, parents) {
    for (const node of nodes || []) {
      const names = parents.concat(node.name);
      if (node.id === nodeId) return '/' + names.join('/');
      const childPath = find(node.children, names);
      if (childPath) return childPath;
    }
    return '';
  }

  const path = find(data.data, []);
  if (!path) throw new Error('node_id was not found in the MeterSphere module tree: ' + nodeId);
  return path;
}

let targetNodeId = input.node_id;
if (!targetNodeId && input.case_id) {
  const detailResponse = await helpers.httpRequest({
    method: 'GET',
    url: baseUrl + '/track/test/case/get/' + input.case_id,
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
  if (!detail.success) throw new Error('Unable to read existing test case: ' + detail.message);
  targetNodeId = detail.data.nodeId;
}
if (!targetNodeId) throw new Error('node_id is required');
const nodePath = await resolveNodePath(targetNodeId);
`;

let patched = 0;
for (const node of workflow.nodes ?? []) {
  if (!['Create Test Case', 'Edit Test Case'].includes(node.name)) continue;
  const code = node.parameters?.jsCode;
  if (typeof code !== 'string') continue;

  let next = code;
  if (!next.includes('function normalizeArrayField(')) {
    next = next.replace('const body = {', helper + '\nconst body = {');
  } else {
    next = next.replace(
      /  if \(fieldName === 'tags'\) \{\n    parsed = parsed\.map\(\(tag\) => String\(tag\)\.trim\(\)\)\.filter\(Boolean\);\n  \}\n/,
      `  if (fieldName === 'tags') {\n    parsed = parsed.map((tag) => String(tag).trim()).filter(Boolean);\n  } else if (fieldName === 'steps') {\n    parsed = parsed.map((step, index) => {\n      if (!step || typeof step !== 'object' || Array.isArray(step)) {\n        throw new Error('steps[' + index + '] must be an object');\n      }\n      return {\n        ...step,\n        id: step.id || crypto.randomUUID().replace(/-/g, '').slice(0, 8),\n        num: Number.isFinite(Number(step.num)) ? Number(step.num) : index + 1,\n        desc: String(step.desc ?? ''),\n        result: String(step.result ?? ''),\n      };\n    });\n  }\n`,
    );
  }

  next = next.replace(
    "const maintainer = input.maintainer || '';",
    "const maintainer = input.maintainer || 'jiabowang@moego.pet';",
  );

  if (!next.includes('async function resolveNodePath(')) {
    next = next.replace('const body = {', nodePathResolver + '\nconst body = {');
  }

  next = next.replace("  nodePath: '',", '  nodePath,');
  next = next.replace('  nodeId: input.node_id,', '  nodeId: targetNodeId,');
  next = next.replace("  nodeId: input.node_id || '',", '  nodeId: targetNodeId,');

  next = next.replace(
    /tags:\s*input\.tags\s*\|\|\s*'\[\]',/,
    "tags: normalizeArrayField(input.tags, 'tags', []),",
  );

  if (node.name === 'Create Test Case') {
    next = next.replace(
      /steps:\s*input\.steps\s*\|\|\s*JSON\.stringify\(\[\{id:\s*crypto\.randomUUID\(\)\.slice\(0,8\),\s*num:\s*1,\s*desc:\s*'',\s*result:\s*''\}\]\),/,
      "steps: normalizeArrayField(input.steps, 'steps', [{ id: crypto.randomUUID().slice(0, 8), num: 1, desc: '', result: '' }]),",
    );
  } else {
    next = next.replace(
      /steps:\s*input\.steps\s*\|\|\s*'\[\]',/,
      "steps: normalizeArrayField(input.steps, 'steps', []),",
    );
  }

  if (!next.includes("tags: normalizeArrayField(input.tags, 'tags', []),")) {
    throw new Error(`Failed to patch tags in node: ${node.name}`);
  }
  if (!next.includes("steps: normalizeArrayField(input.steps, 'steps'")) {
    throw new Error(`Failed to patch steps in node: ${node.name}`);
  }
  if (!next.includes("const maintainer = input.maintainer || 'jiabowang@moego.pet';")) {
    throw new Error(`Failed to patch maintainer in node: ${node.name}`);
  }
  if (!next.includes('const nodePath = await resolveNodePath(targetNodeId);')) {
    throw new Error(`Failed to patch nodePath in node: ${node.name}`);
  }

  if (next === code) {
    throw new Error(`No patch applied to node: ${node.name}`);
  }
  node.parameters.jsCode = next;
  patched += 1;
}

if (patched !== 1) {
  throw new Error(`Expected exactly one matching Code node, patched ${patched}`);
}

process.stdout.write(JSON.stringify(workflow));
