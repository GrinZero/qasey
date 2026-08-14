/**
 * 飞书文档 Block → Markdown 转换
 * 用于 n8n Code node (Run Once for All Items)
 *
 * 输入: 飞书 /docx/v1/documents/{id}/blocks API 返回的 items 数组
 * 输出: [{ json: { content, title, document_id } }]
 */

const input = $input.first().json;
const blocks = input.data?.items || [];
const documentId = $('Execute Workflow Trigger').first().json.document_id;

// --- TextElement 转文本 ---
function textElementsToMarkdown(elements) {
  if (!elements || !elements.length) return '';
  return elements.map(el => {
    const textRun = el.text_run;
    if (!textRun) return '';
    let text = textRun.content || '';
    const style = textRun.text_element_style || {};
    if (style.bold) text = `**${text}**`;
    if (style.italic) text = `*${text}*`;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.inline_code) text = `\`${text}\``;
    if (style.link?.url) text = `[${text}](${style.link.url})`;
    return text;
  }).join('');
}

// --- 单个 block 转 Markdown ---
function blockToMarkdown(block) {
  const type = block.block_type;

  switch (type) {
    // 页面标题
    case 1: { // page
      const text = textElementsToMarkdown(block.page?.elements);
      return text ? `# ${text}` : '';
    }

    // 文本段落
    case 2: { // text
      return textElementsToMarkdown(block.text?.elements);
    }

    // 标题 heading1-9
    case 3: { // heading1
      const text = textElementsToMarkdown(block.heading1?.elements);
      return `# ${text}`;
    }
    case 4: { // heading2
      const text = textElementsToMarkdown(block.heading2?.elements);
      return `## ${text}`;
    }
    case 5: { // heading3
      const text = textElementsToMarkdown(block.heading3?.elements);
      return `### ${text}`;
    }
    case 6: { // heading4
      const text = textElementsToMarkdown(block.heading4?.elements);
      return `#### ${text}`;
    }
    case 7: { // heading5
      const text = textElementsToMarkdown(block.heading5?.elements);
      return `##### ${text}`;
    }
    case 8: { // heading6
      const text = textElementsToMarkdown(block.heading6?.elements);
      return `###### ${text}`;
    }
    case 9: { // heading7
      const text = textElementsToMarkdown(block.heading7?.elements);
      return `####### ${text}`;
    }
    case 10: { // heading8
      const text = textElementsToMarkdown(block.heading8?.elements);
      return `######## ${text}`;
    }
    case 11: { // heading9
      const text = textElementsToMarkdown(block.heading9?.elements);
      return `######### ${text}`;
    }

    // 无序列表
    case 12: { // bullet
      const text = textElementsToMarkdown(block.bullet?.elements);
      return `- ${text}`;
    }

    // 有序列表
    case 13: { // ordered
      const text = textElementsToMarkdown(block.ordered?.elements);
      return `1. ${text}`;
    }

    // 代码块
    case 14: { // code
      const text = textElementsToMarkdown(block.code?.elements);
      const lang = block.code?.style?.language || '';
      // 飞书语言枚举映射
      const langMap = {
        1: 'plaintext', 2: 'abap', 3: 'ada', 4: 'apache',
        5: 'apex', 6: 'assembly', 7: 'bash', 8: 'csharp',
        9: 'cpp', 10: 'c', 11: 'cobol', 12: 'css',
        13: 'coffeescript', 14: 'd', 15: 'dart', 16: 'delphi',
        17: 'django', 18: 'dockerfile', 19: 'erlang', 20: 'fortran',
        22: 'go', 23: 'groovy', 24: 'html', 25: 'http',
        26: 'haskell', 27: 'json', 28: 'java', 29: 'javascript',
        30: 'julia', 31: 'kotlin', 32: 'latex', 33: 'lisp',
        34: 'lua', 35: 'makefile', 36: 'markdown', 37: 'matlab',
        39: 'objectivec', 40: 'openedgeabl', 41: 'php', 42: 'perl',
        43: 'powershell', 44: 'prolog', 45: 'protobuf', 46: 'python',
        47: 'r', 48: 'rpm', 49: 'ruby', 50: 'rust',
        51: 'sas', 52: 'scala', 53: 'scheme', 54: 'scratch',
        55: 'shell', 56: 'sql', 57: 'swift', 58: 'thrift',
        59: 'typescript', 60: 'vbscript', 61: 'visual_basic', 62: 'xml',
        63: 'yaml'
      };
      const langStr = langMap[lang] || '';
      return `\`\`\`${langStr}\n${text}\n\`\`\``;
    }

    // 引用
    case 15: { // quote
      const text = textElementsToMarkdown(block.quote?.elements);
      return text.split('\n').map(line => `> ${line}`).join('\n');
    }

    // TODO
    case 17: { // todo
      const text = textElementsToMarkdown(block.todo?.elements);
      const checked = block.todo?.style?.done ? 'x' : ' ';
      return `- [${checked}] ${text}`;
    }

    // 分割线
    case 22: { // divider
      return '---';
    }

    // 图片
    case 27: { // image
      const token = block.image?.token || '';
      return `![image](feishu://image/${token})`;
    }

    // 表格容器 - 表格内容通过 children blocks 构建
    case 31: { // table
      // 表格需要通过子 block 构建，这里标记一下
      return `[表格: ${block.table?.property?.row_size || '?'}行 × ${block.table?.property?.column_size || '?'}列]`;
    }

    // 任务列表
    case 33: { // task
      const text = textElementsToMarkdown(block.task?.elements);
      return `- [ ] ${text}`;
    }

    // 高亮块 / callout
    case 34: { // callout
      const text = textElementsToMarkdown(block.callout?.elements);
      return `> 💡 ${text}`;
    }

    default:
      return '';
  }
}

// --- 主转换逻辑 ---
const lines = [];
let title = '';

for (const block of blocks) {
  // 提取文档标题（第一个 page block）
  if (block.block_type === 1 && !title) {
    title = textElementsToMarkdown(block.page?.elements);
  }

  const md = blockToMarkdown(block);
  if (md) {
    lines.push(md);
  }
}

const content = lines.join('\n\n');

return [{
  json: {
    title,
    document_id: documentId,
    content,
    url: `https://open.feishu.cn/docx/${documentId}`
  }
}];
