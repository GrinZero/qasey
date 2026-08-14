/**
 * 通用过滤 + 输出预算 Code Node — 所有 figma workflow 的最后一步
 *
 * 输入: 上游预处理结果（含 nodes / components / threads 之一）
 * 输出: 过滤 + 按 token 预算切片后的结果，附续取信息
 *
 * 为什么不用「最多 N 条」：
 *   旧实现是 MAX_RESULTS=200 的固定条数上限。条数和 token 不成比例 ——
 *   200 个浅层节点可能只有 3k token，而 200 条中文评论轻松超 20k。
 *   所以这里改成按 token 预算切，条数不设限。
 *
 * 为什么要 CJK 感知：
 *   英文 JSON 大约 4 字符/token，中文大约 1.5 字符/token，差 2.6 倍。
 *   评论正文是中文为主，用固定「字符数/4」估算会严重低估，切完照样超预算。
 *
 * 截断语义：不静默丢弃。超预算时返回 truncated=true + next_offset，
 * 并在 hint 里用中文写清怎么续取 —— 和 qa_experience_read 的翻页语义保持一致。
 * 切片边界永远落在完整条目（完整话题 / 完整顶层子树）上，不切碎结构。
 */

// MCP 单次响应上限 25000 token，留 20% 余量给外层包装和 hint 文本
const TOKEN_BUDGET = 20000;

const input = $input.first().json;
const params = $('When Executed by Another Workflow').first().json;
const filterCode = params.filter_code || '';

function asInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}
const offset = asInt(params.offset, 0, 0, 1000000);

// CJK 感知的 token 估算：CJK 约 1.5 字符/token，其余约 4 字符/token
function estimateTokens(str) {
  if (!str) return 0;
  let cjk = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) ||
        (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
  }
  const other = str.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

// --- 确定要处理哪个数组 ---
let data, varName, outputKey;
if (Array.isArray(input.nodes)) {
  data = input.nodes; varName = 'nodes'; outputKey = 'nodes';
} else if (Array.isArray(input.components)) {
  data = input.components; varName = 'components'; outputKey = 'components';
} else if (Array.isArray(input.threads)) {
  // filter_code 里变量名沿用 comments，对 agent 更直观
  data = input.threads; varName = 'comments'; outputKey = 'threads';
} else {
  return [{ json: input }];
}

// --- 执行 agent 传入的过滤 ---
let filtered = data;
let filterError = null;
if (filterCode) {
  try {
    const fn = new Function(varName, `return (${filterCode})`);
    const r = fn(data);
    if (!Array.isArray(r)) {
      filterError = 'filter_code 必须返回数组';
      filtered = [];
    } else {
      filtered = r;
    }
  } catch (e) {
    filterError = `filter_code 执行出错: ${e.message}`;
    filtered = [];
  }
}

const total = filtered.length;
const windowed = filtered.slice(offset);

// --- 按 token 预算逐条累加，切在完整条目边界 ---
const picked = [];
let used = 0;
let truncated = false;
for (const item of windowed) {
  const cost = estimateTokens(JSON.stringify(item));
  if (picked.length > 0 && used + cost > TOKEN_BUDGET) {
    truncated = true;
    break;
  }
  picked.push(item);
  used += cost;
  // 单条就超预算：已收下它保证有进展，但立即停下
  if (used > TOKEN_BUDGET) {
    truncated = windowed.length > picked.length;
    break;
  }
}

// --- 组装输出 ---
const output = {};
for (const [k, v] of Object.entries(input)) {
  if (k !== outputKey) output[k] = v;
}
output[outputKey] = picked;
output.returned = picked.length;
output.total = total;

if (offset > 0) output.offset = offset;
if (filterError) output.filter_error = filterError;

if (truncated) {
  const nextOffset = offset + picked.length;
  output.truncated = true;
  output.next_offset = nextOffset;
  output.hint =
    `输出达 token 预算，本次返回第 ${offset + 1}-${nextOffset} 条，共 ${total} 条。` +
    `把 offset=${nextOffset} 传回本工具可续取剩余部分；` +
    `或用 filter_code 收窄范围以减少无关内容。`;
}

return [{ json: output }];
