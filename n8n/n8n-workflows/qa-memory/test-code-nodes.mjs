/**
 * 本地跑 qa_experience_list 的两个 Code Node，用 mock 飞书响应验证逻辑。
 * 不碰 n8n、不发网络请求。用法: node n8n-workflows/qa-memory/_test-code-nodes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const resolveCode = read('qa_experience_list-resolve.js');
const formatCode = read('qa_experience_list-format.js');

/** 用 n8n 的方式执行 Code Node：注入 $input 和 $ */
async function runNode(code, { inputJson, refs = {} }) {
  const $input = { first: () => ({ json: inputJson }) };
  const $ = (nodeName) => {
    if (!(nodeName in refs)) throw new Error(`测试未提供节点引用: ${nodeName}`);
    return { first: () => ({ json: refs[nodeName] }) };
  };
  const fn = new AsyncFunction('$input', '$', code);
  return fn($input, $);
}

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const ROOT = 'Ug8RwLT93iJjM4kR32HcpnBpnuh';

// ---------- Resolve Target ----------
console.log('\n[Resolve Target]');
{
  const r = (await runNode(resolveCode, { inputJson: {} }))[0].json;
  check('不传 parent → 回落 ROOT_TOKEN', r.target_token === ROOT, r.target_token);
  check('不传 parent → is_root=true', r.is_root === true);
  check('不传 page_token → 空串', r.page_token === '');
}
{
  const r = (await runNode(resolveCode, { inputJson: { parent: 'Xa1abc', page_token: 'pt99' } }))[0].json;
  check('传 parent → 用 parent', r.target_token === 'Xa1abc');
  check('传 parent → is_root=false', r.is_root === false);
  check('page_token 透传', r.page_token === 'pt99');
}
{
  // agent 常见的脏输入
  const r = (await runNode(resolveCode, { inputJson: { parent: '  ', page_token: 'undefined' } }))[0].json;
  check('空白 parent → 回落 ROOT', r.target_token === ROOT);
  check("字符串 'undefined' 的 page_token → 清成空串", r.page_token === '');
}
{
  const r = (await runNode(resolveCode, { inputJson: { parent: 'null' } }))[0].json;
  check("字符串 'null' 的 parent → 回落 ROOT", r.target_token === ROOT);
}

// ---------- Format：正常目录 ----------
console.log('\n[Format — 正常目录]');
{
  const refs = {
    'Resolve Target': { target_token: ROOT, page_token: '', is_root: true },
    'Get Node': {
      code: 0,
      msg: 'success',
      data: { node: { space_id: '7123', node_token: ROOT, obj_token: 'DocABC', obj_type: 'docx', title: 'QA 经验', has_child: true } },
    },
  };
  const listResp = {
    code: 0,
    data: {
      items: [
        { node_token: 'Xa1', obj_token: 'oA', obj_type: 'docx', title: '支付', has_child: true },
        { node_token: 'Xb2', obj_token: 'oB', obj_type: 'docx', title: '退款场景踩坑', has_child: false },
        { node_token: 'Xc3', obj_token: 'oC', obj_type: 'sheet', title: '', has_child: false },
      ],
      has_more: true,
      page_token: 'next123',
    },
  };
  const r = (await runNode(formatCode, { inputJson: listResp, refs }))[0].json;

  check('无 error 标记', !r.error);
  check('items 数量 3', r.items.length === 3);
  check('有子节点的 → is_folder=true', r.items[0].is_folder === true);
  check('无子节点的 → is_folder=false', r.items[1].is_folder === false);
  check('空标题兜底为 (无标题)', r.items[2].title === '(无标题)');
  check('url 用 node_token 拼', r.items[1].url.endsWith('/wiki/Xb2'), r.items[1].url);
  check('parent.title 正确', r.parent.title === 'QA 经验');
  check('parent.is_root 透传', r.parent.is_root === true);
  check('has_more 透传', r.has_more === true);
  check('next_page_token 透传', r.next_page_token === 'next123');
  check('有 items 时不加 hint', r.parent.hint === undefined);
}

// ---------- Format：叶子节点 ----------
console.log('\n[Format — 叶子节点]');
{
  const refs = {
    'Resolve Target': { target_token: 'Xb2', page_token: '', is_root: false },
    'Get Node': {
      code: 0,
      data: { node: { space_id: '7123', node_token: 'Xb2', obj_type: 'docx', title: '退款场景踩坑', has_child: false } },
    },
  };
  const r = (await runNode(formatCode, { inputJson: { code: 0, data: { items: [], has_more: false } }, refs }))[0].json;
  check('items 为空', r.items.length === 0);
  check('给出「改用 read」的 hint', /qa_experience_read/.test(r.parent.hint || ''), r.parent.hint);
  check('is_root=false', r.parent.is_root === false);
}

// ---------- Format：get_node 失败 ----------
console.log('\n[Format — get_node 失败]');
{
  const refs = {
    'Resolve Target': { target_token: 'BADTOKEN', page_token: '', is_root: false },
    'Get Node': { code: 1254004, msg: 'node not exist' },
  };
  const r = (await runNode(formatCode, { inputJson: { code: 0, data: { items: [] } }, refs }))[0].json;
  check('标记 error', r.error === true);
  check('消息含 token', /BADTOKEN/.test(r.message));
  check('消息含飞书 code', /1254004/.test(r.message));
  check('items 空数组而非 undefined', Array.isArray(r.items) && r.items.length === 0);
}

// ---------- Format：list 失败 ----------
console.log('\n[Format — list children 失败]');
{
  const refs = {
    'Resolve Target': { target_token: ROOT, page_token: '', is_root: true },
    'Get Node': { code: 0, data: { node: { space_id: '7123', node_token: ROOT, title: 'QA 经验' } } },
  };
  const r = (await runNode(formatCode, { inputJson: { code: 99991663, msg: 'permission denied' }, refs }))[0].json;
  check('标记 error', r.error === true);
  check('消息含 list 失败原因', /permission denied/.test(r.message));
  check('parent 仍带 title', r.parent?.title === 'QA 经验');
}

// ---------- Format：HTTP 层异常（onError 透传的形状） ----------
console.log('\n[Format — HTTP 异常兜底]');
{
  const refs = {
    'Resolve Target': { target_token: ROOT, page_token: '', is_root: true },
    'Get Node': { error: 'connect ETIMEDOUT' }, // 没有 code 字段
  };
  const r = (await runNode(formatCode, { inputJson: {}, refs }))[0].json;
  check('无 code 字段也判为 error', r.error === true);
  check('不抛异常', true);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
