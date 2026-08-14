/**
 * qa_experience_list — 输出整形 Code Node
 *
 * 把飞书 wiki 子节点列表整形成「文件系统 ls」语义的响应。
 * 不做打分、不做排序过滤 —— 目录原样返回，由 agent 自己决定下钻还是读正文。
 *
 * 输入:
 *   $('Resolve Target')  → { target_token, page_token, is_root }
 *   $('Get Node')        → 飞书 wiki/v2/spaces/get_node 响应
 *   $input               → 飞书 wiki/v2/spaces/{space_id}/nodes 响应
 * 输出: [{ json: { parent, items, has_more, next_page_token } }]
 */

const WIKI_DOMAIN = 'https://mengshikeji.feishu.cn/wiki/';

const resolved = $('Resolve Target').first().json;
const nodeResp = $('Get Node').first().json;
const listResp = $input.first().json;

// --- get_node 失败：token 无效 / 无权限 / 不是 wiki 节点 ---
if (!nodeResp || nodeResp.code !== 0 || !nodeResp.data?.node) {
  return [{
    json: {
      error: true,
      message:
        `无法解析节点 ${resolved.target_token}：` +
        `${nodeResp?.msg || '未知错误'}（code=${nodeResp?.code ?? 'n/a'}）。` +
        '请确认传入的是 wiki 节点 token（飞书链接 /wiki/<token> 中的那一段），且当前授权用户有权访问。',
      parent: null,
      items: [],
      has_more: false,
      next_page_token: '',
    },
  }];
}

const targetNode = nodeResp.data.node;

// --- 子节点列表失败 ---
if (!listResp || listResp.code !== 0) {
  return [{
    json: {
      error: true,
      message: `列出子节点失败：${listResp?.msg || '未知错误'}（code=${listResp?.code ?? 'n/a'}）`,
      parent: { title: targetNode.title || '', node_token: targetNode.node_token },
      items: [],
      has_more: false,
      next_page_token: '',
    },
  }];
}

const rawItems = listResp.data?.items || [];

const items = rawItems.map((n) => ({
  title: n.title || '(无标题)',
  node_token: n.node_token,
  obj_type: n.obj_type || '',
  // has_child 是「能否继续下钻」的唯一依据。飞书 wiki 任意节点都可挂子节点，
  // 所以 is_folder 为 true 的节点自身也可能有正文，两者不互斥。
  is_folder: !!n.has_child,
  url: n.node_token ? `${WIKI_DOMAIN}${n.node_token}` : '',
}));

const parent = {
  title: targetNode.title || '',
  node_token: targetNode.node_token,
  obj_type: targetNode.obj_type || '',
  is_root: !!resolved.is_root,
  url: targetNode.node_token ? `${WIKI_DOMAIN}${targetNode.node_token}` : '',
};

// 叶子节点：没有子节点，agent 该做的是读正文而不是继续 ls
if (items.length === 0) {
  parent.hint =
    '该节点没有子节点。如果它本身是一篇经验文档，请把它的 node_token 传给 qa_experience_read 读取正文。';
}

return [{
  json: {
    parent,
    items,
    has_more: !!listResp.data?.has_more,
    next_page_token: listResp.data?.page_token || '',
  },
}];
