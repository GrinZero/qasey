#!/usr/bin/env node
/**
 * 部署 Figma MCP workflow 到 n8n
 *
 * 用法:
 *   node deploy-figma-workflows.js --dry-run   只校验并打印将执行的命令，不写线上
 *   node deploy-figma-workflows.js             实际部署
 *   node deploy-figma-workflows.js --only=figma_get_components.json
 *
 * 和旧版的区别（都是踩过的坑）：
 *
 * 1) 按 workflow ID 更新，不再按 name 查找。按 name 匹配在重名/改名时会更新错对象，
 *    甚至误建新 workflow。ID 是稳定标识，写死更安全。
 * 2) 提交前剥离只读字段。n8n API 对 id / active / createdAt / updatedAt / versionId /
 *    tags / meta / pinData 这些字段会直接报 400，必须只提交
 *    name / nodes / connections / settings。
 * 3) 不再做 PLACEHOLDER 替换。代码已内联在各 .json 的 jsCode 里，
 *    同目录的 .js 文件是给人读和改的副本，靠 --check-sync 校验两边一致。
 * 4) 部署前逐个校验：JSON 合法、每个 code node 的 JS 语法合法、
 *    parameters 里 $('节点名') 引用的节点确实存在。
 *    最后一条是因为 figma_get_components 曾长期引用一个不存在的
 *    'Execute Workflow Trigger'，导致该 tool 100% 报 "Referenced node doesn't exist"。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;

// 线上 workflow ID —— 按 ID 更新，避免按名字匹配到错误对象
const WORKFLOWS = [
  { json: 'figma_list_pages.json', id: 'Mwjs5faEuXJbBug5' },
  { json: 'figma_get_page_structure.json', id: 'LpGobmBnYGd0QdOo' },
  { json: 'figma_get_node_detail.json', id: 'utW6xeVjsG5DokL8' },
  { json: 'figma_export_image.json', id: 'eEmA2e1FtsrKlYbA' },
  { json: 'figma_get_components.json', id: 'd1o6srECh5wJnLqt' },
  { json: 'figma_get_comments.json', id: 'xPIPElbNex3hSmrl' },
  { json: 'figma_query_nodes.json', id: 'ukDzWq6FCDJ3II1x' },
  // MCP server 放最后：子 workflow 先就位，避免中间态下 tool schema 与实现不匹配
  { json: 'figma_mcp_server.json', id: 'PxzkTrDZ2Jk9ogGS' },
];

// n8n API 拒绝的只读字段
const READONLY = ['id', 'active', 'createdAt', 'updatedAt', 'versionId', 'tags', 'meta', 'pinData', 'shared', 'triggerCount', 'isArchived'];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

function validate(wf, filename) {
  const problems = [];
  const names = new Set(wf.nodes.map((n) => n.name));

  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.code') {
      const tmp = path.join(os.tmpdir(), `_chk_${process.pid}.js`);
      fs.writeFileSync(tmp, node.parameters.jsCode || '');
      try {
        execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
      } catch (e) {
        problems.push(`${node.name}: JS 语法错误 ${String(e.stderr || '').slice(0, 160)}`);
      } finally {
        fs.existsSync(tmp) && fs.unlinkSync(tmp);
      }
    }
    // $('节点名') 引用的节点必须存在，否则线上运行时才炸
    const blob = JSON.stringify(node.parameters || {});
    const refs = new Set([...blob.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    for (const ref of refs) {
      if (!names.has(ref)) problems.push(`${node.name}: 引用了不存在的节点 '${ref}'`);
    }
  }
  return problems;
}

function strip(wf) {
  const out = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings || {},
  };
  for (const k of READONLY) delete out[k];
  return out;
}

let ok = 0;
let failed = 0;

for (const cfg of WORKFLOWS) {
  if (only && cfg.json !== only) continue;
  const p = path.join(DIR, cfg.json);
  process.stdout.write(`\n--- ${cfg.json} (${cfg.id}) ---\n`);

  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`  ✗ JSON 不合法: ${e.message}`);
    failed++;
    continue;
  }

  const problems = validate(wf, cfg.json);
  if (problems.length) {
    problems.forEach((x) => console.error(`  ✗ ${x}`));
    failed++;
    continue;
  }
  console.log('  ✓ 校验通过（JSON / JS 语法 / 节点引用）');

  const payload = strip(wf);
  const tmp = path.join(os.tmpdir(), `_deploy_${cfg.id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));

  const cmd = `n8n-cli workflow update ${cfg.id} --file="${tmp}"`;
  if (DRY) {
    console.log(`  [dry-run] ${cmd}`);
    ok++;
    continue;
  }

  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    console.log(`  ✓ 已部署`);
    ok++;
  } catch (e) {
    console.error(`  ✗ 部署失败: ${String(e.stderr || e.message).slice(0, 300)}`);
    failed++;
  } finally {
    fs.existsSync(tmp) && fs.unlinkSync(tmp);
  }
}

console.log(`\n=== ${DRY ? '校验' : '部署'}完成: ${ok} 成功, ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);
