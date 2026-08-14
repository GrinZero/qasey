/**
 * 本地验证 lark-doc-read 的 Blocks to Markdown 代码（组装后）。
 * 重点覆盖 2026-08-03 修的分页截断 bug。
 * 用法: node n8n-workflows/test-lark-doc-read.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const code = [
  read('lark-doc-read-head.js').trimEnd(),
  '',
  read('lark-doc-read-converter.js').trimEnd(),
  read('lark-doc-read-tail.js').trimEnd(),
  '',
].join('\n');

/** 按 n8n 的方式执行：$input.all() 返回多页 */
async function run(pages, refs) {
  const $input = {
    all: () => pages.map((json) => ({ json })),
    first: () => ({ json: pages[0] }),
  };
  const $ = (name) => {
    if (!(name in refs)) throw new Error(`测试未提供节点引用: ${name}`);
    return { first: () => ({ json: refs[name] }) };
  };
  return new AsyncFunction('$input', '$', code)($input, $);
}

/** 单页若干 block 的便捷构造 */
const onePage = (items) => [{ code: 0, data: { items, has_more: false } }];

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const textBlock = (s) => ({ block_type: 2, text: { elements: [{ text_run: { content: s } }] } });
const pageBlock = (s) => ({ block_type: 1, page: { elements: [{ text_run: { content: s } }] } });

const REFS = {
  'Resolve Wiki Token': { code: 0, data: { node: { obj_token: 'DocABC', space_id: '7', node_token: 'WikiXYZ' } } },
  'When Executed by Another Workflow': { document_id: 'WikiXYZ' },
};

// ---------- 单页（回归：原有行为不能变） ----------
console.log('\n[单页 — 回归]');
{
  const r = (await run([{ code: 0, data: { items: [pageBlock('标题'), textBlock('正文')], has_more: false } }], REFS))[0].json;
  check('标题提取正确', r.title === '标题');
  check('正文包含', r.content.includes('正文'));
  check('markdown 标题格式', r.content.startsWith('# 标题'));
  check('document_id 用 obj_token', r.document_id === 'DocABC');
  check('truncated=false', r.truncated === false);
  check('total_blocks=2', r.total_blocks === 2);
  check('page_count=1', r.page_count === 1);
  check('无截断警告', !r.content.includes('⚠️'));
}

// ---------- 多页合并（核心修复） ----------
console.log('\n[多页合并 — 核心修复]');
{
  const p1 = { code: 0, data: { items: [pageBlock('清单'), textBlock('第一页内容')], has_more: true, page_token: 'pt2' } };
  const p2 = { code: 0, data: { items: [textBlock('第二页内容')], has_more: true, page_token: 'pt3' } };
  const p3 = { code: 0, data: { items: [textBlock('第三页内容')], has_more: false } };
  const r = (await run([p1, p2, p3], REFS))[0].json;

  check('三页 block 全部合并', r.total_blocks === 4, `实际 ${r.total_blocks}`);
  check('page_count=3', r.page_count === 3);
  check('第一页内容在', r.content.includes('第一页内容'));
  check('第二页内容在（修复前会丢）', r.content.includes('第二页内容'));
  check('第三页内容在（修复前会丢）', r.content.includes('第三页内容'));
  check('末页 has_more=false → fetch_incomplete=false', r.fetch_incomplete === false);
  check('未超预算 → truncated=false', r.truncated === false);
  check('无警告', !r.content.includes('⚠️'));
  check('标题仍从首个 page block 取', r.title === '清单');
}

// ---------- 撞上 maxRequests 上限 ----------
console.log('\n[撞分页上限 — 必须告警]');
{
  const pages = Array.from({ length: 20 }, (_, i) => ({
    code: 0,
    data: { items: [textBlock(`第${i + 1}页`)], has_more: true, page_token: `pt${i + 2}` },
  }));
  const r = (await run(pages, REFS))[0].json;
  check('fetch_incomplete=true', r.fetch_incomplete === true);
  check('正文带 ⚠️ 警告', r.content.includes('⚠️'), r.content.slice(-60));
  check('警告里含实际 block 数', r.content.includes('20 个 block'));
  check('已取到的内容仍返回', r.content.includes('第1页') && r.content.includes('第20页'));
}

// ---------- 飞书返回业务错误 ----------
console.log('\n[飞书业务错误]');
{
  const r = (await run([{ code: 1770001, msg: 'invalid param' }], REFS))[0].json;
  check('标记 error', r.error === true);
  check('消息含飞书 msg', /invalid param/.test(r.message));
  check('消息含 code', /1770001/.test(r.message));
  check('content 为空串而非 undefined', r.content === '');
  check('给出可操作提示', /token/.test(r.message));
}
{
  // 首页成功、次页报错
  const p1 = { code: 0, data: { items: [textBlock('ok')], has_more: true, page_token: 'pt2' } };
  const p2 = { code: 99991663, msg: 'permission denied' };
  const r = (await run([p1, p2], REFS))[0].json;
  check('任一页报错即标记 error', r.error === true);
  check('消息含次页错因', /permission denied/.test(r.message));
}

// ---------- HTTP 层异常，无可用 body ----------
console.log('\n[HTTP 层异常兜底]');
{
  const r = (await run([{ error: 'ETIMEDOUT' }], REFS))[0].json;
  check('标记 error', r.error === true);
  check('消息含 document_id', /DocABC/.test(r.message), r.message);
  check('不抛异常', true);
}
{
  const r = (await run([{}], REFS))[0].json;
  check('空 body 也判 error', r.error === true);
}

// ---------- 富文本能力未被破坏 ----------
console.log('\n[转换器主体未被破坏]');
{
  const blocks = [
    { block_type: 3, heading1: { elements: [{ text_run: { content: 'H1' } }] } },
    { block_type: 12, bullet: { elements: [{ text_run: { content: '列表项' } }] } },
    { block_type: 22 },
    { block_type: 2, text: { elements: [{ text_run: { content: '粗体', text_element_style: { bold: true } } }] } },
    { block_type: 2, text: { elements: [{ text_run: { content: '链接', text_element_style: { link: { url: 'https%3A%2F%2Fa.com' } } } }] } },
    { block_type: 14, code: { elements: [{ text_run: { content: 'x=1' } }], style: { language: 46 } } },
  ];
  const r = (await run([{ code: 0, data: { items: blocks, has_more: false } }], REFS))[0].json;
  check('heading1 → #', r.content.includes('# H1'));
  check('bullet → -', r.content.includes('- 列表项'));
  check('divider → ---', r.content.includes('---'));
  check('bold → **', r.content.includes('**粗体**'));
  check('link URL 已解码', r.content.includes('(https://a.com)'), r.content);
  check('code 语言映射 python', r.content.includes('```python'));
}

// ---------- 字符预算：小文档不受影响 ----------
console.log('\n[字符预算 — 小文档不截断]');
{
  const r = (await run(onePage([pageBlock('清单'), textBlock('短正文')]), REFS))[0].json;
  check('truncated=false', r.truncated === false);
  check('next_block_offset=null', r.next_block_offset === null);
  check('无 message 字段', r.message === undefined);
  check('无 ⚠️ 警告', !r.content.includes('⚠️'));
  check('returned_blocks=2', r.returned_blocks === 2);
  check('total_blocks=2', r.total_blocks === 2);
  check('max_chars 默认 30000', r.max_chars === 30000);
}

// ---------- 字符预算：超预算截断 ----------
console.log('\n[字符预算 — 超预算截断]');
{
  // 每 block 1000 字符 × 50 = 5 万字符，默认预算 3 万
  const big = Array.from({ length: 50 }, (_, i) => textBlock('x'.repeat(1000) + `#${i}`));
  const r = (await run(onePage([pageBlock('长文'), ...big]), REFS))[0].json;

  check('truncated=true', r.truncated === true);
  check('char_count 不超预算', r.char_count <= 30000, `实际 ${r.char_count}`);
  check('next_block_offset 有值', typeof r.next_block_offset === 'number');
  check('returned_blocks < total_blocks', r.returned_blocks < r.total_blocks);
  check('正文带续读提示', /block_offset=/.test(r.content));
  check('message 指明怎么续读', /block_offset=/.test(r.message || ''));
  check('标题仍取到', r.title === '长文');
}

// ---------- 续读：offset 能推进并最终读完 ----------
console.log('\n[续读 — 全程无丢失无死循环]');
{
  const big = Array.from({ length: 50 }, (_, i) => textBlock('y'.repeat(1000) + `#${i}`));
  const allBlocks = [pageBlock('长文'), ...big];

  let offset = 0;
  let rounds = 0;
  const seen = [];
  const offsets = [];
  while (true) {
    if (++rounds > 20) { check('续读未陷入死循环', false, '超过 20 轮'); break; }
    const refs = { ...REFS, 'When Executed by Another Workflow': { document_id: 'WikiXYZ', block_offset: offset } };
    const r = (await run(onePage(allBlocks), refs))[0].json;
    offsets.push(offset);
    for (let i = 0; i < 50; i++) if (r.content.includes(`#${i}`)) seen.push(i);
    check(`第 ${rounds} 轮 title 仍在`, r.title === '长文');
    if (!r.truncated) break;
    if (r.next_block_offset <= offset) { check('offset 必须前进', false, `${offset} → ${r.next_block_offset}`); break; }
    offset = r.next_block_offset;
  }
  const unique = new Set(seen);
  check('多轮续读后 50 个 block 全覆盖', unique.size === 50, `实际 ${unique.size}`);
  check('轮数合理（3~6 轮）', rounds >= 2 && rounds <= 6, `实际 ${rounds} 轮`);
  check('offset 严格递增', offsets.every((v, i) => i === 0 || v > offsets[i - 1]));
}

// ---------- 单个巨型 block：不能卡死 ----------
console.log('\n[单个 block 超预算 — 不能卡死]');
{
  const huge = textBlock('z'.repeat(50000));
  const r = (await run(onePage([huge, textBlock('后续')]), REFS))[0].json;
  check('仍产出该 block（不返回空）', r.content.includes('z'.repeat(100)));
  check('returned_blocks >= 1', r.returned_blocks >= 1);
  check('next_block_offset 已推进', r.next_block_offset === null || r.next_block_offset >= 1);
}

// ---------- max_chars 自定义与夹取 ----------
console.log('\n[max_chars 参数]');
{
  const blocks = Array.from({ length: 20 }, (_, i) => textBlock('w'.repeat(500) + `#${i}`));
  const mk = (v) => ({ ...REFS, 'When Executed by Another Workflow': { document_id: 'WikiXYZ', max_chars: v } });

  const small = (await run(onePage(blocks), mk(2000)))[0].json;
  check('max_chars=2000 生效', small.char_count <= 2000, `实际 ${small.char_count}`);
  check('小预算下 truncated=true', small.truncated === true);

  const str = (await run(onePage(blocks), mk('3000')))[0].json;
  check('字符串数字被接受', str.max_chars === 3000);

  const over = (await run(onePage(blocks), mk(9999999)))[0].json;
  check('超大值被夹到 200000', over.max_chars === 200000);

  const bad = (await run(onePage(blocks), mk('abc')))[0].json;
  check('非法值回落默认 30000', bad.max_chars === 30000);

  const neg = (await run(onePage(blocks), mk(-5)))[0].json;
  check('负数回落默认', neg.max_chars === 30000);
}

// ---------- block_offset 边界 ----------
console.log('\n[block_offset 边界]');
{
  const blocks = [pageBlock('T'), textBlock('a'), textBlock('b')];
  const mk = (v) => ({ ...REFS, 'When Executed by Another Workflow': { document_id: 'WikiXYZ', block_offset: v } });

  const past = (await run(onePage(blocks), mk(999)))[0].json;
  check('offset 超出总数 → 空内容不报错', past.returned_blocks === 0);
  check('offset 超出时 truncated=false', past.truncated === false);
  check('offset 超出时 title 仍在', past.title === 'T');

  const mid = (await run(onePage(blocks), mk(2)))[0].json;
  check('offset=2 跳过前两个 block', !mid.content.includes('a') && mid.content.includes('b'));
  check('block_offset 回显', mid.block_offset === 2);

  const strOff = (await run(onePage(blocks), mk('1')))[0].json;
  check('字符串 offset 被接受', strOff.block_offset === 1);
}

// ---------- fetch_incomplete 与 truncated 是两件事 ----------
console.log('\n[fetch_incomplete vs truncated]');
{
  const pages = Array.from({ length: 20 }, (_, i) => ({
    code: 0,
    data: { items: [textBlock(`p${i}`)], has_more: true, page_token: `pt${i + 2}` },
  }));
  const r = (await run(pages, REFS))[0].json;
  check('撞抓取上限 → fetch_incomplete=true', r.fetch_incomplete === true);
  check('内容未超预算 → truncated=false', r.truncated === false);
  check('正文提示达抓取上限', /抓取上限/.test(r.content));
  check('message 说明 total_blocks 不是真实总数', /并非文档真实总数/.test(r.message || ''));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
