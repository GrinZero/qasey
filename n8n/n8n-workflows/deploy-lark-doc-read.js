#!/usr/bin/env node
/**
 * 部署 lark-doc-read 到 n8n
 *
 * 用法:
 *   node deploy-lark-doc-read.js --dry-run   # 只组装 + 校验，不写 n8n
 *   node deploy-lark-doc-read.js             # 部署
 *
 * Blocks to Markdown 的代码由三段拼成，便于在不动转换器主体的前提下改取数逻辑：
 *   lark-doc-read-head.js       取数 + 分页合并 + 错误处理
 *   lark-doc-read-converter.js  block → markdown 转换器（从线上原样提取，勿随意改）
 *   lark-doc-read-tail.js       主循环 + 截断警告 + 输出
 *
 * ⚠️ 这个 workflow 被两个 MCP Server 复用（Lark Docs MCP Server 的 lark_doc_read，
 *    QA Memory MCP Server 的 qa_experience_read / qa_checklist_get），改动请两边都验。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const WF_ID = 'QzCdkJGyNNqhk0kG';
const DRY_RUN = process.argv.includes('--dry-run');

const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf-8');

function buildMarkdownCode() {
  return [
    read('lark-doc-read-head.js').trimEnd(),
    '',
    read('lark-doc-read-converter.js').trimEnd(),
    read('lark-doc-read-tail.js').trimEnd(),
    '',
  ].join('\n');
}

const code = buildMarkdownCode();

// 语法检查：n8n Code node 把代码包在函数体里执行，所以顶层 return 合法
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
try {
  new AsyncFunction('$input', '$', code);
} catch (e) {
  console.error(`✗ 组装后代码语法错误: ${e.message}`);
  process.exit(1);
}

const workflow = JSON.parse(read('lark-doc-read.json'));
const node = workflow.nodes.find((n) => n.name === 'Blocks to Markdown');
if (!node) throw new Error('找不到 Blocks to Markdown 节点');
if (node.parameters.jsCode !== 'PLACEHOLDER_MARKDOWN_CODE') {
  throw new Error('lark-doc-read.json 里的 jsCode 不是预期的占位符，请检查是否被手工改过');
}
node.parameters.jsCode = code;

// n8n API 只读字段，带上会 400
for (const ro of ['tags', 'id', 'active', 'createdAt', 'updatedAt']) delete workflow[ro];

console.log(`组装完成：${code.split('\n').length} 行`);

if (DRY_RUN) {
  console.log('[dry-run] 语法与 JSON 均合法，跳过部署');
  process.exit(0);
}

const tmp = path.join(DIR, '_tmp_lark-doc-read.json');
fs.writeFileSync(tmp, JSON.stringify(workflow, null, 2));
try {
  execFileSync('n8n-cli', ['workflow', 'update', WF_ID, `--file=${tmp}`], { encoding: 'utf-8' });
  console.log(`✓ 已更新 lark-doc-read (${WF_ID})`);
} finally {
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
}
