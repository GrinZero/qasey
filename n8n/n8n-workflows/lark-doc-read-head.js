/**
 * lark-doc-read — Blocks to Markdown 的取数头部
 *
 * 两层限制，管的是两件不同的事：
 *   1. Fetch Blocks 节点的 maxRequests(20) × page_size(500) —— 护 n8n 侧内存，
 *      这些请求在服务端发生，不进调用方 context。
 *   2. 这里的 MAX_CHARS 字符预算 —— 护调用方 context。block 大小能差两个数量级
 *      （表格 ~7 字符/block，长段落 ~500），所以按 block 数设限是很差的代理指标，必须按字符算。
 *
 * 历史：曾经只取第一页 → 超 500 block 的文档静默截断（2026-08-03 修）；
 *       随后发现全量返回会炸 context → 加字符预算 + block_offset 续读（同日修）。
 */

// 中文密集文本约 1 token/字，所以 30k 字符 ≈ 25-30k token（不是按英文 3 字符/token 估的 10k）。
// 取 30k 的理由：经验库里的文档实测 0.3k-4.5k 字符，这个值让正常文档一次读完、零多余往返，
// 只拦住异常大的文档（误读长 PRD 之类）。调低到 15k 换不来好处 —— 没有文档落在 15k-30k 区间。
const DEFAULT_MAX_CHARS = 30000;
const HARD_MAX_CHARS = 200000; // 调用方就算传更大也不放行，避免一次调用打爆 context

const pages = $input.all();
const wikiResult = $('Resolve Wiki Token').first().json;
const webhookInput = $('When Executed by Another Workflow').first().json;
const documentId = wikiResult?.data?.node?.obj_token || webhookInput.document_id || webhookInput.query;

// --- 入参归一化：agent 可能传字符串数字、空串、负数 ---
const toInt = (v, fallback) => {
  const n = typeof v === 'string' ? parseInt(v.trim(), 10) : v;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
const blockOffset = toInt(webhookInput.block_offset, 0);
const maxChars = Math.min(toInt(webhookInput.max_chars, DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS, HARD_MAX_CHARS);

const errorOut = (message) => [{
  json: {
    error: true,
    title: '',
    document_id: documentId || '',
    content: '',
    message,
    url: '',
  },
}];

// --- 飞书返回错误：给出可操作信息，而不是让 raw HTTP error 冒到调用方 ---
const failedPage = pages.find((p) => p.json?.code !== undefined && p.json.code !== 0);
if (failedPage) {
  const c = failedPage.json;
  return errorOut(
    `读取文档失败：${c.msg || '未知错误'}（code=${c.code}）。` +
      '请确认 token 正确（飞书链接 /wiki/<token> 或 /docx/<token> 中的那一段），且当前授权用户有权访问。',
  );
}

// 上游 HTTP 层异常时 pages 可能完全没有可用 body
if (!pages.length || pages.every((p) => !p.json?.data)) {
  return errorOut(`未能取到文档 ${documentId || '(未知)'} 的任何内容，请确认 token 与访问权限。`);
}

// --- 合并所有分页的 block ---
const blocks = [];
for (const p of pages) {
  const items = p.json?.data?.items;
  if (Array.isArray(items)) blocks.push(...items);
}

// 最后一页仍报 has_more，说明撞到 maxRequests 上限，连 block 都没取全
const lastPage = pages[pages.length - 1]?.json;
const fetchIncomplete = !!lastPage?.data?.has_more;
