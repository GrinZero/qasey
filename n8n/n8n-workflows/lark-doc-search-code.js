/**
 * 飞书文档搜索结果格式化
 * 用于 n8n Code node (Run Once for All Items)
 *
 * 输入: 飞书搜索 API 返回
 * 输出: [{ json: { results, total, query } }]
 */

const input = $input.first().json;
const query = $('Execute Workflow Trigger').first().json.query;
const docsData = input.data || {};
const docs = docsData.docs_entities || [];
const total = docsData.total || 0;

const results = docs.map(doc => {
  // 文档类型映射
  const typeMap = {
    doc: '旧版文档',
    docx: '新版文档',
    sheet: '电子表格',
    bitable: '多维表格',
    mindnote: '思维笔记',
    slides: '幻灯片',
    wiki: '知识库节点',
    file: '文件'
  };

  return {
    title: doc.title || '无标题',
    url: doc.url || '',
    doc_type: typeMap[doc.docs_type] || doc.docs_type,
    owner: doc.owner?.name || '',
    preview: doc.preview || '',
    doc_token: doc.docs_token || '',
    create_time: doc.create_time
      ? new Date(doc.create_time * 1000).toISOString()
      : null,
    update_time: doc.update_time
      ? new Date(doc.update_time * 1000).toISOString()
      : null
  };
});

return [{
  json: {
    query,
    total,
    results
  }
}];
