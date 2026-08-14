#!/usr/bin/env node
/**
 * 部署 QA Memory MCP workflow 到 n8n
 *
 * 用法:
 *   node deploy-qa-memory-workflows.js            # 部署
 *   node deploy-qa-memory-workflows.js --dry-run  # 只做替换和 JSON 校验，不写 n8n
 *
 * 顺序有依赖：先部署 qa_experience_list 拿到它的 workflow id，
 * 再把 id 注入 MCP Server 的 PLACEHOLDER_LIST_WF_ID 后部署 server。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DRY_RUN = process.argv.includes('--dry-run');

const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf-8');

/** 把 JS 代码安全转义成 JSON 字符串字面量的内容（不含外层引号） */
function jsonEscape(code) {
  const quoted = JSON.stringify(code);
  return quoted.slice(1, -1);
}

function n8n(args) {
  return execFileSync('n8n-cli', args, { encoding: 'utf-8' });
}

function listWorkflows() {
  return JSON.parse(n8n(['workflow', 'list', '--json']));
}

/**
 * 部署单个 workflow。已存在同名则 update，否则 create。
 * @returns {string} workflow id
 */
function deploy(jsonFile, replacements = {}) {
  console.log(`\n--- ${jsonFile} ---`);

  let content = read(jsonFile);

  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!content.includes(placeholder)) {
      throw new Error(`${jsonFile} 里找不到占位符 ${placeholder}`);
    }
    content = content.split(placeholder).join(value);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`替换后 JSON 非法: ${e.message}`);
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] JSON 合法，${parsed.nodes.length} 个节点，跳过部署`);
    return 'DRY_RUN_ID';
  }

  // n8n API 把这些字段当只读，带上会直接 400。
  // 仓库里的 JSON 保留 tags 是为了跟现有 workflow 格式一致，提交时不动，只在发给 API 前剥掉。
  for (const readOnly of ['tags', 'id', 'active', 'createdAt', 'updatedAt']) {
    delete parsed[readOnly];
  }

  const tmp = path.join(DIR, `_tmp_${jsonFile}`);
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));

  try {
    const existing = listWorkflows().find((w) => w.name === parsed.name);
    let id;

    if (existing) {
      n8n(['workflow', 'update', existing.id, `--file=${tmp}`]);
      id = existing.id;
      console.log(`  ✓ 已更新 ${parsed.name} (${id})`);
    } else {
      const out = n8n(['workflow', 'create', `--file=${tmp}`, '--json']);
      id = JSON.parse(out).id;
      console.log(`  ✓ 已创建 ${parsed.name} (${id})`);
    }
    return id;
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

// --- 主流程 ---
console.log(`部署 QA Memory MCP workflow${DRY_RUN ? '（dry-run）' : ''}...`);

try {
  const listId = deploy('qa_experience_list.json', {
    PLACEHOLDER_RESOLVE: jsonEscape(read('qa_experience_list-resolve.js')),
    PLACEHOLDER_FORMAT: jsonEscape(read('qa_experience_list-format.js')),
  });

  deploy('qa_memory_mcp_server.json', {
    PLACEHOLDER_LIST_WF_ID: listId,
  });

  console.log('\n=== 完成 ===');
  if (!DRY_RUN) {
    console.log('两个 workflow 尚未激活，需要时执行:');
    console.log(`  n8n-cli workflow activate ${listId}`);
    console.log('  n8n-cli workflow activate <QA Memory MCP Server 的 id>');
  }
} catch (e) {
  console.error(`\n✗ 失败: ${e.message}`);
  process.exit(1);
}
