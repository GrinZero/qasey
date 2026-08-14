/**
 * figma_get_page_structure — 预处理 Code Node
 * 将 Figma API 返回的节点树转为标准化 FigmaNode[]
 *
 * 输入: Figma GET /v1/files/:key/nodes 响应
 * 输出: [{ json: { page_name, nodes, total_count } }]
 */

const input = $input.first().json;
const params = $('When Executed by Another Workflow').first().json;
// MCP 的入参 schema 全是 string，agent 传 false 到达时是字符串 "false"（真值），
// 传 0 会被 || 吃掉。两者都必须先归一化。
function asBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return !['false', '0', 'no', 'off'].includes(String(v).trim().toLowerCase());
}
function asInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

const depth = asInt(params.depth, 2, 1, 5);
const textOnly = asBool(params.text_only, false);
const includeLayout = asBool(params.include_layout, false);

/**
 * 取 variant 轴。两个来源，缺一不可：
 *  1) componentPropertyDefinitions 里 type==='VARIANT' 的项 —— 标准来源；
 *  2) 子 COMPONENT 的名字，形如 "state=hover, size=md" —— MoeGo 设计系统实际用的是
 *     TEXT / INSTANCE_SWAP 属性，VARIANT 项为空，真正的 variant 值只在子组件名里。
 * 只走来源 1 会恒得 {}，这就是之前 variants 永远是空对象的原因。
 * 用普通对象做去重表，不要用 Set：n8n 沙箱会把 Set 序列化成 {"hover":true} 而非数组。
 */
function extractVariants(node) {
  const axes = {};
  const defs = node.componentPropertyDefinitions || {};
  for (const [rawKey, def] of Object.entries(defs)) {
    if (!def || def.type !== 'VARIANT' || !Array.isArray(def.variantOptions)) continue;
    const k = rawKey.split('#')[0];
    axes[k] = axes[k] || {};
    for (const opt of def.variantOptions) axes[k][opt] = true;
  }
  for (const child of (node.children || [])) {
    if (!child.name || child.name.indexOf('=') === -1) continue;
    for (const pair of child.name.split(',')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const k = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (!k || !val) continue;
      axes[k] = axes[k] || {};
      axes[k][val] = true;
    }
  }
  const out = {};
  for (const [k, seen] of Object.entries(axes)) out[k] = Object.keys(seen);
  return Object.keys(out).length ? out : undefined;
}

// --- 转换函数 ---
function transformNode(node, currentDepth, maxDepth, textOnlyMode) {
  if (!node) return null;

  const result = {
    id: node.id,
    name: node.name || '',
    type: node.type || 'UNKNOWN',
  };
  // visible 绝大多数为 true，是默认值。只在反常（隐藏）时输出，省掉每个节点的固定开销。
  if (node.visible === false) result.hidden = true;

  if (node.type === 'TEXT') {
    result.characters = node.characters || '';
  }

  if (node.type === 'INSTANCE' && node.componentId) {
    result.component_id = node.componentId;
  }

  if (node.type === 'COMPONENT_SET' || node.type === 'COMPONENT') {
    const v = extractVariants(node);
    if (v) result.variants = v;   // 空对象整个字段不输出，不占噪音
  }

  // 像素尺寸实测占输出 34% 的体积，但写测试用例几乎用不到，默认不输出。
  // 需要看间距/尺寸时显式传 include_layout=true。
  // layout_mode（HORIZONTAL/VERTICAL）是理解结构的信息，不是尺寸噪音，故始终保留。
  if (includeLayout && node.absoluteBoundingBox) {
    result.layout = {
      width: Math.round(node.absoluteBoundingBox.width),
      height: Math.round(node.absoluteBoundingBox.height),
    };
  }
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    result.layout_mode = node.layoutMode;
  }

  if (node.children && node.children.length > 0) {
    if (currentDepth < maxDepth) {
      const children = node.children
        .map(child => transformNode(child, currentDepth + 1, maxDepth, textOnlyMode))
        .filter(Boolean);
      if (children.length > 0) {
        result.children = children;
      }
      result.children_count = node.children.length;
    } else {
      result.children_count = node.children.length;
    }
  }

  if (textOnlyMode && node.type !== 'TEXT') {
    if (!result.children || result.children.length === 0) {
      return null;
    }
  }

  return result;
}

// --- 计数 ---
function countNodes(node) {
  if (!node) return 0;
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

// --- 主逻辑 ---
const nodesMap = input.nodes || {};
const pageId = params.page_id;
const pageData = nodesMap[pageId];

if (!pageData || !pageData.document) {
  return [{ json: { error: `Page node ${pageId} not found`, nodes: [] } }];
}

const rootNode = pageData.document;
const transformed = transformNode(rootNode, 0, depth, textOnly);
const nodes = transformed ? (transformed.children || []) : [];
const totalCount = countNodes(rootNode) - 1; // 减去 page 本身

return [{
  json: {
    page_name: rootNode.name || '',
    page_id: pageId,
    nodes,
    total_count: totalCount,
    depth_used: depth,
    text_only: textOnly,
  }
}];
