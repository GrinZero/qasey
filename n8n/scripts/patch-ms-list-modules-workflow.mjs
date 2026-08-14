import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected workflow JSON on stdin');

const workflow = JSON.parse(input);

const trigger = (workflow.nodes ?? []).find(
  (node) => node.type === 'n8n-nodes-base.executeWorkflowTrigger',
);
if (!trigger) throw new Error('Execute Workflow Trigger was not found');

trigger.parameters = {
  workflowInputs: {
    values: [
      { name: 'query', type: 'string' },
      { name: 'node_id', type: 'string' },
      { name: 'parent_id', type: 'string' },
      { name: 'offset', type: 'number' },
      { name: 'limit', type: 'number' },
    ],
  },
};

const formatter = (workflow.nodes ?? []).find((node) => node.name === 'Format Output');
if (!formatter || formatter.type !== 'n8n-nodes-base.code') {
  throw new Error('Format Output Code node was not found');
}

formatter.parameters.jsCode = String.raw`const response = $input.first().json;
if (!response.success) throw new Error('MeterSphere API error: ' + response.message);

const request = $('When Executed by Another Workflow').first().json || {};
const query = String(request.query ?? '').trim();
const nodeId = String(request.node_id ?? '').trim();
const parentId = String(request.parent_id ?? '').trim();
const selectors = [query, nodeId, parentId].filter(Boolean);

if (selectors.length > 1) {
  return [{
    json: {
      success: false,
      error: 'validation_error',
      message: 'Use only one selector: query, node_id, or parent_id.',
      modules: [],
    },
  }];
}

const parsedOffset = Number(request.offset ?? 0);
const parsedLimit = Number(request.limit ?? 20);
const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : 0;
const limit = Number.isFinite(parsedLimit)
  ? Math.min(100, Math.max(1, Math.floor(parsedLimit)))
  : 20;

const modules = [];
function flatten(nodes, parentPath = '') {
  for (const node of nodes || []) {
    const path = parentPath ? parentPath + '/' + node.name : '/' + node.name;
    const children = Array.isArray(node.children) ? node.children : [];
    modules.push({
      id: node.id,
      name: node.name,
      path,
      parent_id: node.parentId || null,
      is_leaf: children.length === 0,
      child_count: children.length,
    });
    flatten(children, path);
  }
}
flatten(response.data);

let mode = 'roots';
let matches;
if (nodeId) {
  mode = 'node_id';
  matches = modules.filter((module) => module.id === nodeId);
} else if (parentId) {
  mode = 'parent_id';
  matches = modules.filter((module) => module.parent_id === parentId);
} else if (query) {
  mode = 'query';
  const normalized = query.toLocaleLowerCase();
  matches = modules.filter((module) =>
    module.name.toLocaleLowerCase().includes(normalized)
    || module.path.toLocaleLowerCase().includes(normalized)
    || module.id.toLocaleLowerCase() === normalized
  );
} else {
  const rootIds = new Set((response.data || []).map((node) => node.id));
  matches = modules.filter((module) => rootIds.has(module.id));
}

const totalMatches = matches.length;
const page = matches.slice(offset, offset + limit);
const outputModules = [];
const byteBudget = 96 * 1024;

for (const module of page) {
  const candidate = {
    success: true,
    mode,
    query: query || null,
    node_id: nodeId || null,
    parent_id: parentId || null,
    offset,
    limit,
    total_matches: totalMatches,
    returned: outputModules.length + 1,
    truncated: false,
    next_offset: null,
    modules: [...outputModules, module],
  };
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > byteBudget) break;
  outputModules.push(module);
}

const consumed = offset + outputModules.length;
const truncated = outputModules.length < page.length || consumed < totalMatches;

return [{
  json: {
    success: true,
    mode,
    query: query || null,
    node_id: nodeId || null,
    parent_id: parentId || null,
    offset,
    limit,
    total_matches: totalMatches,
    returned: outputModules.length,
    truncated,
    next_offset: consumed < totalMatches ? consumed : null,
    modules: outputModules,
  },
}];
`;

const httpNode = (workflow.nodes ?? []).find((node) => node.name === 'Get Modules');
if (!httpNode || httpNode.type !== 'n8n-nodes-base.httpRequest') {
  throw new Error('Get Modules HTTP Request node was not found');
}
httpNode.retryOnFail = true;
httpNode.maxTries = 3;
httpNode.waitBetweenTries = 5000;

process.stdout.write(JSON.stringify(workflow));
