/**
 * figma_get_comments — 预处理 Code Node
 *
 * 输入: Figma GET /v1/files/:key/comments?as_md=true 响应
 * 输出: [{ json: { threads: [...], total_threads, total_comments } }]
 *
 * 两处和旧实现的关键区别：
 *
 * 1) 按话题聚合，不再拉平。旧实现把 405 条评论按时间倒序拉平后砍到 50 条，
 *    回复和它的父评论被切散在不同位置甚至被丢掉，agent 拿到一堆接不上的碎片。
 *    设计评审的信息恰恰在「谁回了谁」里，所以改成 replies 挂在父评论下。
 * 2) 不再输出恒空字段。实测 resolved_at / node_id / node_offset 100% 为 null，
 *    order_date 和 created_at 完全重复，这些每条都占位置却零信息量。
 *    改成只在真有值时才出现。
 *
 * 截断不在这里做 —— 交给下游 Apply Filter 按 token 预算切，且切在完整话题边界上。
 */

const input = $input.first().json;
const rawComments = input.comments || [];

// 设计评审只需要日期，秒级精度是噪音
function toDate(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

function shape(c) {
  const o = {
    id: c.id,
    author: c.user?.handle || c.user?.name || 'unknown',
    date: toDate(c.created_at),
    message: c.message || '',
  };
  // 以下字段只在反常/有值时输出
  if (c.resolved_at) o.resolved = true;
  const nodeId = c.client_meta?.node_id;
  if (nodeId) o.node_id = nodeId;
  return o;
}

// --- 按 parent_id 聚合成话题 ---
const byId = new Map();
const roots = [];

for (const c of rawComments) {
  byId.set(c.id, { raw: c, shaped: shape(c) });
  if (!c.parent_id) roots.push(c.id);
}

// 挂回复。父评论可能不在本次响应里（被删等），这类回复升级为独立话题，避免静默丢失。
const repliesOf = new Map();
for (const c of rawComments) {
  if (!c.parent_id) continue;
  if (!byId.has(c.parent_id)) {
    roots.push(c.id);
    continue;
  }
  if (!repliesOf.has(c.parent_id)) repliesOf.set(c.parent_id, []);
  repliesOf.get(c.parent_id).push(c.id);
}

function buildThread(rootId) {
  const entry = byId.get(rootId);
  if (!entry) return null;
  const thread = { ...entry.shaped };
  const replyIds = repliesOf.get(rootId) || [];
  if (replyIds.length) {
    // 回复按时间正序，读起来就是对话本身的顺序
    replyIds.sort((a, b) => {
      const ra = byId.get(a), rb = byId.get(b);
      return new Date(ra.raw.created_at) - new Date(rb.raw.created_at);
    });
    thread.replies = replyIds.map((id) => byId.get(id).shaped);
  }
  return thread;
}

// 话题按最新活动时间倒序（含回复），活跃讨论排在前面
function lastActivity(rootId) {
  const ids = [rootId].concat(repliesOf.get(rootId) || []);
  let max = 0;
  for (const id of ids) {
    const t = new Date(byId.get(id).raw.created_at).getTime() || 0;
    if (t > max) max = t;
  }
  return max;
}

const threads = roots
  .map((id) => ({ id, ts: lastActivity(id) }))
  .sort((a, b) => b.ts - a.ts)
  .map((x) => buildThread(x.id))
  .filter(Boolean);

const totalComments = threads.reduce(
  (n, t) => n + 1 + (t.replies ? t.replies.length : 0),
  0
);

return [{
  json: {
    threads,
    total_threads: threads.length,
    total_comments: totalComments,
  },
}];
