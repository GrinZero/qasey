/**
 * figma_get_node_detail — 预处理 Code Node
 * 全深度展开指定节点，返回完整 FigmaNode 结构
 *
 * 输入: Figma GET /v1/files/:key/nodes 响应
 * 输出: [{ json: { nodes: FigmaNode[] } }]
 */

const input = $input.first().json;
const params = $('When Executed by Another Workflow').first().json;
// MCP 的入参 schema 全是 string，agent 传 false 到达时是字符串 "false"（真值）。
// 必须先归一化，否则 include_styles 永远关不掉。
function asBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return !['false', '0', 'no', 'off'].includes(String(v).trim().toLowerCase());
}

const includeStyles = asBool(params.include_styles, true);

// {r,g,b,a} 浮点 -> #rrggbb，读不出颜色的浮点噪音变成人能看懂的值
function toHex(c) {
  if (!c || typeof c.r !== 'number') return null;
  const h = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

function asInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

// 展开深度上限，默认 6。原实现无上限，深层设计稿会把输出撑爆。
const maxDepth = asInt(params.max_depth, 6, 1, 20);

// 全深度转换（maxDepth 设为 99 表示不限制）
function transformNode(node, currentDepth) {
  if (!node) return null;

  const result = {
    id: node.id,
    name: node.name || '',
    type: node.type || 'UNKNOWN',
  };
  // visible 默认为 true，只在反常（隐藏）时输出
  if (node.visible === false) result.hidden = true;

  if (node.type === 'TEXT') {
    result.characters = node.characters || '';
    if (includeStyles && node.style) {
      result.text_style = {
        font_family: node.style.fontFamily,
        font_size: node.style.fontSize,
        font_weight: node.style.fontWeight,
        text_align: node.style.textAlignHorizontal,
      };
    }
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
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      result.layout.layout_mode = node.layoutMode;
    }
  }

  // 样式信息
  if (includeStyles) {
    // Figma 的 color 是 {r,g,b,a} 浮点，序列化后形如
    // {"r":0.06666667014360428,"g":0.06666667014360428,...} —— 单个色值就要 80+ 字符，
    // 而且 agent 读不出这是什么颜色。转成 hex，既短又可读。
    const fills = (node.fills || []).filter(f => f.visible !== false).map(f => {
      const o = { type: f.type };
      const hex = toHex(f.color);
      if (hex) o.color = hex;
      if (f.opacity !== undefined && f.opacity !== 1) o.opacity = Math.round(f.opacity * 100) / 100;
      return o;
    });
    if (fills.length) result.fills = fills;
    const strokes = (node.strokes || []).filter(s => s.visible !== false).map(s => {
      const o = { type: s.type };
      const hex = toHex(s.color);
      if (hex) o.color = hex;
      return o;
    });
    if (strokes.length) result.strokes = strokes;
    if (node.cornerRadius) {
      result.corner_radius = node.cornerRadius;
    }
  }

  // 交互相关
  if (node.interactions && node.interactions.length > 0) {
    result.interactions = node.interactions.map(i => ({
      trigger: i.trigger?.type,
      action: i.actions?.[0]?.type,
      destination: i.actions?.[0]?.destinationId,
    }));
  }

  // 子节点展开。原本是无上限全深度递归——设计稿嵌套很深时输出会失控，
  // 这是「输出经常过大」的主要来源之一。加深度上限，到底时用 children_count 交代还有多少。
  if (node.children && node.children.length > 0) {
    if (currentDepth < maxDepth) {
      result.children = node.children
        .map(child => transformNode(child, currentDepth + 1))
        .filter(Boolean);
      if (!result.children.length) {
        delete result.children;
        result.children_count = node.children.length;
      }
    } else {
      // 未展开，用计数交代规模，并提示如何继续下钻
      result.children_count = node.children.length;
      result.truncated_at_depth = true;
    }
  }

  return result;
}

// --- 主逻辑 ---
const nodesMap = input.nodes || {};
const nodes = [];

for (const [nodeId, nodeData] of Object.entries(nodesMap)) {
  if (nodeData && nodeData.document) {
    const transformed = transformNode(nodeData.document, 0);
    if (transformed) {
      nodes.push(transformed);
    }
  }
}

return [{
  json: {
    nodes,
    count: nodes.length,
  }
}];
