/**
 * Figma 节点预处理 — 将原始 Figma node 转为标准化 FigmaNode
 * 用于 n8n Code node (Run Once for All Items)
 *
 * 输入: Figma API 返回的 node 树
 * 输出: 标准化后的 FigmaNode[]
 */

/**
 * 递归转换单个 Figma node 为 FigmaNode 格式
 */
function transformNode(node, currentDepth, maxDepth, textOnly) {
  if (!node) return null;

  const result = {
    id: node.id,
    name: node.name || '',
    type: node.type || 'UNKNOWN',
    visible: node.visible !== false,
  };

  // 文本节点：提取文字内容
  if (node.type === 'TEXT') {
    result.characters = node.characters || '';
  }

  // 组件实例：提取来源组件 ID
  if (node.type === 'INSTANCE' && node.componentId) {
    result.component_id = node.componentId;
  }

  // COMPONENT_SET / COMPONENT：提取 variant 属性
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

  // 布局信息
  if (node.absoluteBoundingBox) {
    result.layout = {
      width: Math.round(node.absoluteBoundingBox.width),
      height: Math.round(node.absoluteBoundingBox.height),
    };
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      result.layout.layout_mode = node.layoutMode;
    }
  }

  // 子节点处理
  if (node.children && node.children.length > 0) {
    if (currentDepth < maxDepth) {
      const children = node.children
        .map(child => transformNode(child, currentDepth + 1, maxDepth, textOnly))
        .filter(Boolean);
      if (children.length > 0) {
        result.children = children;
      }
      result.children_count = node.children.length;
    } else {
      result.children_count = node.children.length;
    }
  }

  // textOnly 模式：非文本叶子节点跳过，保留有文本子节点的容器
  if (textOnly && node.type !== 'TEXT') {
    if (!result.children || result.children.length === 0) {
      return null;
    }
  }

  return result;
}

/**
 * 将节点树 flatten 为一维数组（用于 query_nodes）
 */
function flattenNodes(node, parentId) {
  if (!node) return [];
  const flat = { ...node, parent_id: parentId || null };
  const children = flat.children || [];
  delete flat.children;
  const result = [flat];
  for (const child of children) {
    result.push(...flattenNodes(child, node.id));
  }
  return result;
}

/**
 * 执行 agent 传入的 filter_code
 * @param {object[]} data - 节点数组
 * @param {string} filterCode - JS 表达式（如 "nodes.filter(n => n.type === 'TEXT')"）
 * @param {string} varName - 输入变量名（nodes/components/comments）
 * @returns {{ data: object[], error?: string }}
 */
function executeFilter(data, filterCode, varName) {
  if (!filterCode) return { data };
  try {
    const fn = new Function(varName, `return (${filterCode})`);
    const result = fn(data);
    if (!Array.isArray(result)) {
      return { data: [], error: 'filter_code must return an array' };
    }
    return { data: result };
  } catch (e) {
    return { data: [], error: `filter_code error: ${e.message}` };
  }
}
