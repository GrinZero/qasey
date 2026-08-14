function textElementsToMarkdown(elements) {
  if (!elements || !elements.length) return '';
  return elements.map(el => {
    const textRun = el.text_run;
    if (!textRun) {
      if (el.mention_doc) {
        const title = el.mention_doc.title || '\u6587\u6863';
        const url = el.mention_doc.url || '';
        return url ? `[${title}](${url})` : title;
      }
      if (el.mention_user) return `@${el.mention_user.user_id || '\u7528\u6237'}`;
      return '';
    }
    let text = textRun.content || '';
    const style = textRun.text_element_style || {};
    if (style.bold) text = `**${text}**`;
    if (style.italic) text = `*${text}*`;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.inline_code) text = '`' + text + '`';
    if (style.link?.url) {
      const url = decodeURIComponent(style.link.url);
      text = `[${text}](${url})`;
    }
    return text;
  }).join('');
}

function blockToMarkdown(block) {
  const t = block.block_type;
  switch (t) {
    case 1: { const text = textElementsToMarkdown(block.page?.elements); return text ? `# ${text}` : ''; }
    case 2: return textElementsToMarkdown(block.text?.elements);
    case 3: return `# ${textElementsToMarkdown(block.heading1?.elements)}`;
    case 4: return `## ${textElementsToMarkdown(block.heading2?.elements)}`;
    case 5: return `### ${textElementsToMarkdown(block.heading3?.elements)}`;
    case 6: return `#### ${textElementsToMarkdown(block.heading4?.elements)}`;
    case 7: return `##### ${textElementsToMarkdown(block.heading5?.elements)}`;
    case 8: return `###### ${textElementsToMarkdown(block.heading6?.elements)}`;
    case 9: return textElementsToMarkdown(block.heading7?.elements);
    case 10: return textElementsToMarkdown(block.heading8?.elements);
    case 11: return textElementsToMarkdown(block.heading9?.elements);
    case 12: return `- ${textElementsToMarkdown(block.bullet?.elements)}`;
    case 13: return `1. ${textElementsToMarkdown(block.ordered?.elements)}`;
    case 14: {
      const text = textElementsToMarkdown(block.code?.elements);
      const langMap = {1:'plaintext',7:'bash',8:'csharp',9:'cpp',10:'c',12:'css',18:'dockerfile',22:'go',24:'html',27:'json',28:'java',29:'javascript',31:'kotlin',34:'lua',36:'markdown',41:'php',46:'python',49:'ruby',50:'rust',52:'scala',55:'shell',56:'sql',57:'swift',59:'typescript',62:'xml',63:'yaml'};
      const lang = langMap[block.code?.style?.language] || '';
      return '```' + lang + '\n' + text + '\n```';
    }
    case 15: { const text = textElementsToMarkdown(block.quote?.elements); return text.split('\n').map(l => `> ${l}`).join('\n'); }
    case 17: { const text = textElementsToMarkdown(block.todo?.elements); return `- [${block.todo?.style?.done ? 'x' : ' '}] ${text}`; }
    case 22: return '---';
    case 27: return `![image](feishu://image/${block.image?.token || ''})`;
    case 31: return `[\u8868\u683C: ${block.table?.property?.row_size || '?'}\u00d7${block.table?.property?.column_size || '?'}]`;
    case 34: return `> \ud83d\udca1 ${textElementsToMarkdown(block.callout?.elements)}`;
    default: return '';
  }
}