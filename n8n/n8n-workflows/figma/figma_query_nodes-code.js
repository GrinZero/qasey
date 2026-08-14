/**
 * figma_query_nodes — Flatten 全树 + 执行 filter_code
 * 合并了预处理和过滤两步（因为 filter_code 在此 tool 中是必填的）
 *
 * 输入: Figma GET /v1/files/:key 响应（完整文件树）
 * 输出: [{ json: { nodes: [...], total_matched, has_more? } }]
 */


const input = $input.first().json;
const params = $('When Executed by Another Workflow').first().json;
const filterCode = params.filter_code;

if (!filterCode) {
  return [{
    json: {
      error: 'filter_code is required for figma_query_nodes',
      nodes: [],
    }
  }];
}

// --- 转换单个节点为精简格式 ---
function transformNode(node) {
  if (!node) return null;
  const result = {
    id: node.id,
    name: node.name || '',
    type: node.type || 'UNKNOWN',
    visible: node.visible !== false,
  };
  if (node.type === 'TEXT') {
    result.characters = node.characters || '';
  }
  if (node.type === 'INSTANCE' && node.componentId) {
    result.component_id = node.componentId;
  }
  if (node.type === 'COMPONENT_SET' || node.type === 'COMPONENT') {
    if (node.componentPropertyDefinitions) {
      result.variants = {};
      for (const [key, def] of Object.entries(node.componentPropertyDefinitions)) {
        if (def.type === 'VARIANT') {
          result.variants[key] = def.variantOptions || [];
        }
      }
    }
  }
  if (node.absoluteBoundingBox) {
    result.layout = {
      width: Math.round(node.absoluteBoundingBox.width),
      height: Math.round(node.absoluteBoundingBox.height),
    };
  }
  return result;
}

// --- Flatten 全树 ---
function flattenTree(node, parentId) {
  if (!node) return [];
  const transformed = transformNode(node);
  if (!transformed) return [];
  transformed.parent_id = parentId || null;

  const result = [transformed];
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenTree(child, node.id));
    }
  }
  return result;
}

// 从 document 开始 flatten
const document = input.document || {};
const allNodes = flattenTree(document, null);

// --- 执行过滤 ---
let filtered = [];
let filterError = null;

try {
  const fn = new Function('nodes', `return (${filterCode})`);
  const result = fn(allNodes);
  if (!Array.isArray(result)) {
    filterError = 'filter_code must return an array';
  } else {
    filtered = result;
  }
} catch (e) {
  filterError = `filter_code error: ${e.message}`;
}

if (filterError) {
  return [{
    json: {
      error: filterError,
      filter_code: filterCode,
      total_nodes_scanned: allNodes.length,
      nodes: [],
    }
  }];
}

// --- 按 token 预算切片，替代原来的固定 200 条上限 ---
// 条数和 token 不成比例：200 个浅层节点可能只 3k token，200 个带长文本的节点能超 20k。
// CJK 约 1.5 字符/token，其余约 4 字符/token，估算必须区分，否则中文内容会严重低估。
const TOKEN_BUDGET = 20000;

function estimateTokens(str) {
  if (!str) return 0;
  let cjk = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) ||
        (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
  }
  return Math.ceil(cjk / 1.5 + (str.length - cjk) / 4);
}

const offsetRaw = parseInt(params.offset, 10);
const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

const totalMatched = filtered.length;
const windowed = filtered.slice(offset);

const picked = [];
let used = 0;
let truncated = false;
for (const item of windowed) {
  const cost = estimateTokens(JSON.stringify(item));
  if (picked.length > 0 && used + cost > TOKEN_BUDGET) { truncated = true; break; }
  picked.push(item);
  used += cost;
  if (used > TOKEN_BUDGET) { truncated = windowed.length > picked.length; break; }
}

const out = {
  nodes: picked,
  returned: picked.length,
  total: totalMatched,
  total_nodes_scanned: allNodes.length,
};
if (offset > 0) out.offset = offset;
if (truncated) {
  const nextOffset = offset + picked.length;
  out.truncated = true;
  out.next_offset = nextOffset;
  out.hint =
    `输出达 token 预算，本次返回第 ${offset + 1}-${nextOffset} 条，共 ${totalMatched} 条。` +
    `把 offset=${nextOffset} 传回可续取；或用 filter_code 收窄范围。` +
    `另：query_nodes 要拉整个文件，是最贵的调用 —— 若目标在单个页面内，` +
    `改用 list_pages + get_page_structure 会快得多也不容易触发限流。`;
}

return [{ json: out }];
