import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const workflow = JSON.parse(
  execFileSync('n8n-cli', ['workflow', 'get', 'CFbiABrf7fX0t2nm', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
const patched = JSON.parse(
  execFileSync('node', ['scripts/patch-ms-upsert-module.mjs'], {
    input: JSON.stringify(workflow),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  }),
);
const code = patched.nodes.find((node) => node.name === 'Upsert Module')?.parameters?.jsCode;
assert.ok(code, 'Patched Upsert Module code was not found');

const rootId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const moduleId = '33333333-3333-4333-8333-333333333333';

const treeBefore = [{
  id: rootId,
  name: 'Root',
  level: 1,
  children: [{
    id: parentId,
    parentId: rootId,
    name: 'Target Parent',
    level: 2,
    children: [{
      id: moduleId,
      parentId,
      name: 'Old Name',
      level: 2,
      children: [],
    }],
  }],
}];
const treeAfter = structuredClone(treeBefore);
treeAfter[0].children[0].children[0].name = 'New Name';

const calls = [];
const helpers = {
  async httpRequest(options) {
    calls.push(options);
    if (options.url.endsWith('/track/case/node/edit')) {
      return { success: true, data: null };
    }
    const treeReadCount = calls.filter((call) => call.method === 'GET').length;
    return { success: true, data: treeReadCount === 1 ? treeBefore : treeAfter };
  },
};
const requireFromCodeNode = (name) => {
  if (name === 'crypto' || name === 'node:crypto') return crypto;
  throw new Error(`Unsupported Code-node dependency: ${name}`);
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('require', '$input', 'helpers', code);
const result = await execute(
  requireFromCodeNode,
  {
    first: () => ({
      json: { module_id: moduleId, name: 'New Name', parent_id: parentId },
    }),
  },
  helpers,
);

assert.equal(result[0].json.id, moduleId);
assert.equal(result[0].json.operation, 'update');
assert.equal(result[0].json.updated, true);
assert.equal(result[0].json.path, '/Root/Target Parent/New Name');

const editCall = calls.find((call) => call.url.endsWith('/track/case/node/edit'));
assert.ok(editCall, 'Expected one MeterSphere edit request');
assert.equal(editCall.method, 'POST');
assert.deepEqual(editCall.body, {
  nodeIds: [moduleId],
  type: 'edit',
  id: moduleId,
  level: 2,
  parentId,
  name: 'New Name',
  label: 'New Name',
  projectId: '20a78db9-19aa-11ee-a261-5a66b98c4036',
});

process.stdout.write('ms_upsert_module mocked edit test passed\n');
