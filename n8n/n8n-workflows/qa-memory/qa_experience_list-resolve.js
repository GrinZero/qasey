/**
 * qa_experience_list — 入参归一化 Code Node
 *
 * parent 留空时回落到 QA 经验文件夹根节点，使「列根目录」和「下钻子目录」
 * 走同一条代码路径（get_node 对根节点和子节点行为一致）。
 *
 * 输入: { parent?, page_token? }
 * 输出: [{ json: { target_token, page_token, is_root } }]
 */

// ---- 配置：换 QA 经验文件夹只需改这一行 ----
// 取自飞书链接 https://mengshikeji.feishu.cn/wiki/<ROOT_TOKEN>
const ROOT_TOKEN = 'Ug8RwLT93iJjM4kR32HcpnBpnuh';

const input = $input.first().json || {};

// agent 可能传空串、字符串 'undefined'/'null'，都当没传
const clean = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return !s || s === 'undefined' || s === 'null' ? '' : s;
};

const parent = clean(input.parent);
const pageToken = clean(input.page_token);

return [{
  json: {
    target_token: parent || ROOT_TOKEN,
    page_token: pageToken,
    is_root: !parent,
  },
}];
