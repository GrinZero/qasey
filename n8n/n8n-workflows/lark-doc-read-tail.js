
// --- 标题：始终从全量 block 里找首个 page block ---
// 不受 block_offset 影响，续读时调用方仍然知道自己在读哪篇文档
let title = '';
for (const block of blocks) {
  if (block.block_type === 1) {
    title = textElementsToMarkdown(block.page?.elements);
    break;
  }
}

// --- 按字符预算转换，在 block 边界切断 ---
const startIdx = Math.min(blockOffset, blocks.length);
const lines = [];
let charCount = 0;
let idx = startIdx;

for (; idx < blocks.length; idx++) {
  const md = blockToMarkdown(blocks[idx]);
  if (!md) continue;

  // 预算已用完就停。但至少要产出一个 block，
  // 否则遇到单个超预算的巨型 block 会永远推不动 offset，续读陷入死循环。
  if (charCount > 0 && charCount + md.length > maxChars) break;

  lines.push(md);
  charCount += md.length + 2; // +2 是 join 的 '\n\n'
}

const consumedBlocks = idx - startIdx;
const truncated = idx < blocks.length;
let content = lines.join('\n\n');

if (truncated) {
  content +=
    `\n\n---\n\n> ⚠️ 内容未完：已返回 block ${startIdx}–${idx - 1}，共 ${blocks.length} 个。` +
    `传 block_offset=${idx} 继续读，或调大 max_chars。请勿当作完整文档使用。`;
} else if (fetchIncomplete) {
  content +=
    `\n\n---\n\n> ⚠️ 文档过长，已达抓取上限（${blocks.length} 个 block），飞书侧仍有未取回的内容。`;
}

const messageParts = [];
if (truncated) {
  messageParts.push(
    `已返回 block ${startIdx}–${idx - 1}（共 ${blocks.length} 个，${charCount} 字符）。` +
      `传 block_offset=${idx} 继续读下一段。`,
  );
}
if (fetchIncomplete) {
  messageParts.push(`注意：文档超出抓取上限，飞书侧仍有未取回的 block，total_blocks 并非文档真实总数。`);
}

return [{
  json: {
    title,
    document_id: documentId,
    content,
    url: `https://feishu.cn/docx/${documentId}`,
    // --- 可观测 / 续读信号 ---
    total_blocks: blocks.length,
    page_count: pages.length,
    returned_blocks: consumedBlocks,
    block_offset: startIdx,
    next_block_offset: truncated ? idx : null,
    truncated,
    fetch_incomplete: fetchIncomplete,
    char_count: charCount,
    max_chars: maxChars,
    ...(messageParts.length ? { message: messageParts.join(' ') } : {}),
  },
}];
