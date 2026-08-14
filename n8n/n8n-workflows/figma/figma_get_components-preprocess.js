/**
 * figma_get_components — 预处理 Code Node
 *
 * 输入: 两个 HTTP node 的结果（/components 和 /component_sets）
 * 输出: [{ json: { components: [...], total_sets, total_standalone } }]
 *
 * 和旧实现的关键区别：
 *
 * 1) 按 component set 聚合 variant 轴。旧实现每个 variant 组合单独输出一行，
 *    Button 有 3 个 state × 3 个 size 就是 9 行，每行 variants 只有一个组合值
 *    （如 {state:"hover", size:"md"}）。agent 想知道「Button 有哪些 state」
 *    得自己把 9 行归并。现在直接给出轴：{state:[...], size:[...]}，一行讲完。
 * 2) 去掉 thumbnail_url。那是 200-400 字符的 S3 签名 URL，每个组件一条，
 *    是输出里最大的单项噪音，而 agent 读不了图片。需要看图用 export_image。
 * 3) 去掉 file_key（入参里就有，回显无意义）和 updated_at（写用例用不到）。
 *
 * 不在这里截断 —— 交给下游 Apply Filter 按 token 预算切。
 */

const items = $input.all();

let rawComponents = [];
let rawSets = [];
for (const item of items) {
  const meta = item.json.meta || {};
  if (meta.components) rawComponents = rawComponents.concat(meta.components);
  if (meta.component_sets) rawSets = rawSets.concat(meta.component_sets);
}

// 从组件名解析 variant 键值对。Figma 的命名约定是 "state=hover, size=md"。
function parsePairs(name) {
  const out = {};
  if (!name || name.indexOf('=') === -1) return out;
  for (const pair of name.split(',')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// set 的 node_id -> 聚合容器。用普通对象做去重表，不要用 Set：
// n8n 沙箱会把 Set 序列化成 {"hover":true} 而不是数组。
const setById = new Map();
for (const cs of rawSets) {
  setById.set(cs.node_id, {
    type: 'COMPONENT_SET',
    name: cs.name || '',
    key: cs.key,
    node_id: cs.node_id || '',
    description: cs.description || '',
    containing_frame: cs.containing_frame?.name || '',
    _axes: {},          // { state: {hover:true, ...} }
    _count: 0,
  });
}

const standalone = [];
for (const c of rawComponents) {
  const parentId = c.containing_frame?.nodeId;
  const parent = parentId ? setById.get(parentId) : undefined;
  const pairs = parsePairs(c.name);

  if (parent && Object.keys(pairs).length) {
    // 属于某个 set 的一个 variant 组合：只把值累进轴里，不单独输出一行
    for (const [k, v] of Object.entries(pairs)) {
      parent._axes[k] = parent._axes[k] || {};
      parent._axes[k][v] = true;
    }
    parent._count++;
    continue;
  }

  const o = {
    type: 'COMPONENT',
    name: c.name || '',
    key: c.key,
    node_id: c.node_id || '',
  };
  if (c.description) o.description = c.description;
  const frame = c.containing_frame?.name;
  if (frame) o.containing_frame = frame;
  standalone.push(o);
}

// 收尾：把去重表转成数组，丢掉内部字段
const sets = [];
for (const s of setById.values()) {
  const out = {
    type: s.type,
    name: s.name,
    key: s.key,
    node_id: s.node_id,
  };
  if (s.description) out.description = s.description;
  if (s.containing_frame) out.containing_frame = s.containing_frame;
  const axes = {};
  for (const [k, seen] of Object.entries(s._axes)) axes[k] = Object.keys(seen);
  if (Object.keys(axes).length) out.variants = axes;
  if (s._count) out.variant_count = s._count;
  sets.push(out);
}

// component set 排前面 —— 它们才是「控件有哪些状态」的答案
const components = sets.concat(standalone);

return [{
  json: {
    components,
    total_sets: sets.length,
    total_standalone: standalone.length,
  },
}];
