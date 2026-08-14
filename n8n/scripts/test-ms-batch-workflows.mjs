import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const workflowDir = path.join(process.cwd(), 'n8n-workflows', 'metersphere');
const CASE_1 = '11111111-1111-4111-8111-111111111111';
const CASE_2 = '22222222-2222-4222-8222-222222222222';
const MODULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MODULE_PATH = '/AI Draft/Safe Batch Target';

function loadWorkflow(fileName, codeNodeName) {
  const workflow = JSON.parse(fs.readFileSync(path.join(workflowDir, fileName), 'utf8'));
  const code = workflow.nodes.find((node) => node.name === codeNodeName)?.parameters?.jsCode;
  if (!code) throw new Error('Code node not found in ' + fileName);
  const projectId = code.match(/const projectId = "([^"]+)";/)?.[1];
  if (!projectId) throw new Error('projectId not found in ' + fileName);
  return { workflow, code, projectId };
}

function baseCase(id, projectId, overrides = {}) {
  return {
    id,
    num: id === CASE_1 ? 1001 : 1002,
    name: id === CASE_1 ? 'Original one' : 'Original two',
    projectId,
    nodeId: MODULE_ID,
    nodePath: MODULE_PATH,
    priority: 'P2',
    maintainer: 'owner@example.com',
    status: 'Prepare',
    type: 'functional',
    prerequisite: '',
    steps: JSON.stringify([{ id: 'step0001', num: 1, desc: 'Open', result: 'Opened' }]),
    tags: JSON.stringify(['existing']),
    remark: '',
    reviewStatus: 'Prepare',
    stepDescription: '',
    expectedResult: '',
    stepModel: 'STEP',
    versionId: 'version-1',
    refId: id,
    latest: true,
    casePublic: false,
    ...overrides,
  };
}

function buildMock(projectId) {
  const cases = new Map([
    [CASE_1, baseCase(CASE_1, projectId)],
    [CASE_2, baseCase(CASE_2, projectId)],
  ]);
  const calls = [];
  const helpers = {
    async httpRequest(options) {
      const url = new URL(options.url);
      const requestPath = url.pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method: options.method, path: requestPath, body });

      if (options.method === 'GET' && requestPath.includes('/track/test/case/get/')) {
        const id = decodeURIComponent(requestPath.split('/').pop());
        const testCase = cases.get(id);
        if (!testCase) return { success: false, message: 'not found' };
        return { success: true, data: structuredClone(testCase) };
      }
      if (options.method === 'GET' && requestPath.includes('/track/case/node/list/')) {
        return {
          success: true,
          data: [{
            id: 'root0000-0000-4000-8000-000000000000',
            name: 'AI Draft',
            children: [{ id: MODULE_ID, name: 'Safe Batch Target', children: [] }],
          }],
        };
      }
      if (options.method === 'POST' && requestPath.endsWith('/track/test/case/batch/edit')) {
        assert.equal(body.condition.selectAll, false);
        assert.deepEqual(body.condition.ids, body.ids);
        for (const id of body.ids) {
          const testCase = cases.get(id);
          if (body.type === 'tags') {
            const current = JSON.parse(testCase.tags || '[]');
            testCase.tags = JSON.stringify(body.appendTag ? [...current, ...body.tagList] : body.tagList);
          } else {
            const value = JSON.parse(body.customField.value);
            const field = {
              用例等级: 'priority',
              用例状态: 'status',
              责任人: 'maintainer',
            }[body.customField.name];
            testCase[field] = value;
          }
        }
        return { success: true, data: null };
      }
      if (options.method === 'POST' && requestPath.endsWith('/track/test/case/minder/edit')) {
        assert.deepEqual(body.ids, []);
        assert.deepEqual(body.testCaseNodes, []);
        assert.deepEqual(body.extraNodeRequest.data, {});
        for (const item of body.data) {
          const current = cases.get(item.id) || {};
          cases.set(item.id, {
            ...current,
            ...item,
            projectId,
            num: current.num || 2000 + cases.size,
          });
        }
        return { success: true, data: null };
      }
      throw new Error('Unexpected mock request: ' + options.method + ' ' + requestPath);
    },
  };
  return { cases, calls, helpers };
}

async function execute(code, input, helpers) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('require', '$input', 'helpers', code);
  return fn(
    (name) => {
      if (name === 'crypto' || name === 'node:crypto') return crypto;
      throw new Error('Unsupported dependency: ' + name);
    },
    { first: () => ({ json: input }) },
    helpers,
  );
}

async function expectValidationFailure(run, pattern) {
  await assert.rejects(run, (error) => {
    assert.match(error.message, /^\[validation_error\]/);
    assert.match(error.message, pattern);
    return true;
  });
}

const batch = loadWorkflow('ms_batch_edit_test_cases.json', 'Batch Edit Test Cases');
{
  const mock = buildMock(batch.projectId);
  const result = await execute(batch.code, {
    case_ids: JSON.stringify([CASE_1, CASE_2]),
    field: 'priority',
    value: 'P1',
    dry_run: true,
  }, mock.helpers);
  assert.equal(result[0].json.dry_run, true);
  assert.equal(result[0].json.case_count, 2);
  assert.equal(mock.calls.some((call) => call.method === 'POST'), false);
}
{
  const mock = buildMock(batch.projectId);
  const result = await execute(batch.code, {
    case_ids: JSON.stringify([CASE_1, CASE_2]),
    field: 'tags',
    value: JSON.stringify(['batch', 'regression']),
    tag_mode: 'replace',
    dry_run: false,
  }, mock.helpers);
  assert.equal(result[0].json.updated_count, 2);
  assert.ok(result[0].json.results.every((item) => item.verified));
  assert.deepEqual(JSON.parse(mock.cases.get(CASE_1).tags), ['batch', 'regression']);
}
{
  const mock = buildMock(batch.projectId);
  await expectValidationFailure(
    () => execute(batch.code, { case_ids: '[]', field: 'priority', value: 'P1' }, mock.helpers),
    /at least one/,
  );
}

const upsert = loadWorkflow('ms_bulk_upsert_test_cases.json', 'Bulk Upsert Test Cases');
{
  const mock = buildMock(upsert.projectId);
  const result = await execute(upsert.code, {
    items: JSON.stringify([
      { operation: 'update', case_id: CASE_1, name: 'Updated safely' },
      {
        operation: 'create',
        name: 'Created safely',
        node_id: MODULE_ID,
        node_path: MODULE_PATH,
        priority: 'P1',
        maintainer: 'owner@example.com',
        steps: [{ num: 1, desc: 'Act', result: 'Expected' }],
        tags: ['batch'],
      },
    ]),
    dry_run: true,
  }, mock.helpers);
  assert.equal(result[0].json.item_count, 2);
  assert.equal(result[0].json.deletion_ids_forced_empty, true);
  assert.equal(mock.calls.some((call) => call.method === 'POST'), false);
}
{
  const mock = buildMock(upsert.projectId);
  const result = await execute(upsert.code, {
    items: JSON.stringify([
      { operation: 'update', case_id: CASE_1, priority: 'P0', remark: 'bulk-safe' },
      {
        operation: 'create',
        name: 'Created safely',
        node_id: MODULE_ID,
        node_path: MODULE_PATH,
        priority: 'P1',
        maintainer: 'owner@example.com',
        steps: [{ num: 1, desc: 'Act', result: 'Expected' }],
        tags: ['batch'],
      },
    ]),
    dry_run: false,
  }, mock.helpers);
  assert.equal(result[0].json.created_count, 1);
  assert.equal(result[0].json.updated_count, 1);
  assert.ok(result[0].json.results.every((item) => item.verified));
  const mutation = mock.calls.find((call) => call.path.endsWith('/track/test/case/minder/edit'));
  assert.deepEqual(mutation.body.ids, []);
  assert.equal(mutation.body.data.some((item) => 'ids' in item), false);
}
{
  const mock = buildMock(upsert.projectId);
  await expectValidationFailure(
    () => execute(upsert.code, {
      items: JSON.stringify([{ operation: 'create', name: 'Unsafe', ids: [CASE_1] }]),
    }, mock.helpers),
    /unsupported fields: ids/,
  );
  await expectValidationFailure(
    () => execute(upsert.code, {
      items: JSON.stringify([{ operation: 'update', case_id: CASE_1, tags: ['not-supported'] }]),
    }, mock.helpers),
    /cannot update tags/,
  );
}

process.stdout.write('MeterSphere batch workflow tests passed\n');
