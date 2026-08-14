#!/usr/bin/env node
/**
 * 修复 Qasey (Vw8YbsOWTmqlNR3o) 的错误上报问题
 *
 * 用法:
 *   node patch-qasey-error-reporting.js --dry-run   # 只打印 before/after diff
 *   node patch-qasey-error-reporting.js             # 实际写入 n8n
 *
 * 背景（执行 19542627 / 19542588 / 19542556）：
 * 三次执行顶层都是 success，但都走了 AI Agent 的 error 分支并往 Slack 发了失败通知。
 * 失败通知里的链接是空的：`抱歉，这次操作没有成功。<|查看执行详情>`
 *
 * 原因：`add failed` 的 text 用了 `$json.execution.url`，但
 *   1) 该节点的 $json 是上游 `Remove a reaction1` 的输出 `{ok:true}`
 *   2) `execution.url` 是 Error Trigger 的 payload 形状，普通节点没有
 *   3) n8n 的 $execution 只有 {id, mode, resumeUrl, resumeFormUrl, customData}，没有 url
 * 所以表达式永远解析不出东西，且失败通知不包含真实报错原因。
 *
 * 真正的根因是 OpenAI Chat Model 返回 502 Bad gateway。
 */

const { execFileSync } = require('child_process');

const WF_ID = 'Vw8YbsOWTmqlNR3o';
const EDITOR_BASE = 'https://n8n.devops.moego.pet';
const DRY_RUN = process.argv.includes('--dry-run');

function n8n(args) {
  return execFileSync('n8n-cli', args, {
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

const wf = JSON.parse(n8n(['workflow', 'get', WF_ID, '--json']));

function node(name) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`找不到节点: ${name}`);
  return n;
}

const changes = [];

/** 记录一次改动，before/after 都打出来便于 review */
function record(nodeName, field, before, after) {
  changes.push({ nodeName, field, before, after });
}

// ---------- 修复 1: `add failed` 的失败通知文案 ----------
// 旧的 $json.execution.url 永远解析不出来，导致 Slack 里是一个空链接，
// 而且完全不说失败原因。改成：
//   - 用 $workflow.id + $execution.id 手工拼执行详情链接
//   - 带上 AI Agent error 分支真实的报错信息（从 isSlack1 取，它是 add failed 的上游）
{
  const n = node('add failed');
  const before = n.parameters.text;
  const after = [
    '=:warning: 抱歉，这次操作没有成功。',
    "原因：{{ $('isSlack1').first().json.error ?? '未知错误（执行详情里看 AI Agent 节点）' }}",
    `<${EDITOR_BASE}/workflow/{{ $workflow.id }}/executions/{{ $execution.id }}|查看执行详情>`,
  ].join('\n');

  if (before !== after) {
    n.parameters.text = after;
    record('add failed', 'parameters.text', before, after);
  }
}

// ---------- 修复 2: `add failed` 回复到正确的 thread ----------
// 旧的用 event_ts（这条 mention 自己的 ts）。thread 里被 @ 时，应该回到原 thread。
// Prepare Slack Prompt 里算 sessionId 用的就是 thread_ts || ts，这里保持一致。
{
  const n = node('add failed');
  const before = n.parameters.otherOptions?.thread_ts?.replyValues?.thread_ts;
  const after =
    "={{ $('Slack Trigger').item.json.thread_ts ?? $('Slack Trigger').item.json.ts }}";

  if (before !== after) {
    n.parameters.otherOptions.thread_ts.replyValues.thread_ts = after;
    record('add failed', 'otherOptions.thread_ts.replyValues.thread_ts', before, after);
  }
}


// ---------- 修复 3: 提高 LLM 重试次数（三次失败的真正根因）----------
// OpenAI Chat Model 返回 502 Bad gateway。maxRetries 默认是 2（见 n8n 源码
// LmChatOpenAi.node.ts: `maxRetries: options.maxRetries ?? 2`），也就是说已经重试过
// 两次仍然失败。502 属于可重试状态码（n8nDefaultFailedAttemptHandler 的
// STATUS_NO_RETRY 只列了 400-409），所以加大重试次数是有意义的。
{
  const n = node('OpenAI Chat Model');
  n.parameters.options = n.parameters.options ?? {};
  const before = n.parameters.options.maxRetries;
  const after = 5;

  if (before !== after) {
    n.parameters.options.maxRetries = after;
    record('OpenAI Chat Model', 'options.maxRetries', String(before ?? '(默认 2)'), String(after));
  }
}

// ---------- 修复 4: Slack 发消息工具的 thread_ts 类型 ----------
// 19542627 里报了 invalid_thread_ts：$fromAI 声明成 'number'，模型输出了
// 1785748968576699（小数点丢了）。它自己重试成 1785748968.576699 才成功。
// 改成 string 并在描述里写清格式，模型就不会再把小数点吃掉。
{
  const n = node('Send a message in Slack(Normal Text)');
  const rv = n.parameters.otherOptions?.thread_ts?.replyValues;
  const before = rv?.thread_ts;
  const after =
    "={{ $fromAI('Message_Timestamp_to_Reply_To', `要回复的消息 ts，必须是带小数点的 Slack 时间戳字符串，例如 1785748538.808529。不要去掉小数点，也不要转成整数。`, 'string') }}";

  if (before !== after) {
    rv.thread_ts = after;
    record(
      'Send a message in Slack(Normal Text)',
      'otherOptions.thread_ts.replyValues.thread_ts',
      before,
      after,
    );
  }
}

// ---------- 修复 5: 频道历史的 latest/oldest 格式提示 ----------
// 19542627 里报了 invalid_ts_latest：模型传了 "1785749000"（整秒），
// Slack 要的是 1785749000.000000 这种格式。
{
  const n = node('Get the history of a channel in Slack');
  const hint =
    '必须是 Slack 时间戳格式（秒 + 6 位小数），例如 1785749000.000000。不要传整数秒，也不要传 ISO 日期。';

  for (const key of ['latest', 'oldest']) {
    const label = key === 'latest' ? 'Latest' : 'Oldest';
    const before = n.parameters.filters?.[key];
    const after = `={{ $fromAI('${label}', \`${hint}\`, 'string') }}`;

    if (before !== after) {
      n.parameters.filters[key] = after;
      record('Get the history of a channel in Slack', `filters.${key}`, before, after);
    }
  }
}

// ---------- 应用 ----------

if (!changes.length) {
  console.log('没有需要改动的地方（可能已经打过补丁）');
  process.exit(0);
}

for (const c of changes) {
  console.log(`\n=== ${c.nodeName} :: ${c.field}`);
  console.log(`--- before:\n${c.before}`);
  console.log(`+++ after:\n${c.after}`);
}

if (DRY_RUN) {
  console.log(`\n[dry-run] 共 ${changes.length} 处改动，未写入 n8n`);
  process.exit(0);
}

// n8n API 的 PUT /workflows/:id 只接受这几个字段，其余（id/active/tags/
// createdAt/updatedAt/versionId...）是只读的，必须剥掉，否则报
// `request/body/... is read-only`
function tryUpdate(settings) {
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
  };
  if (process.env.DUMP_PAYLOAD) {
    require('fs').writeFileSync(process.env.DUMP_PAYLOAD, JSON.stringify(payload, null, 1));
  }
  const args = ['workflow', 'update', WF_ID, '--stdin'];
  if (process.env.N8N_DEBUG) args.push('--debug');
  const out = execFileSync('n8n-cli', args, {
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
    input: JSON.stringify(payload),
    stdio: ['pipe', 'pipe', process.env.N8N_DEBUG ? 'inherit' : 'pipe'],
  });
  if (process.env.DUMP_RESPONSE) {
    require('fs').writeFileSync(process.env.DUMP_RESPONSE, out);
  }
}

// 这个实例的 settings schema 比当前 n8n 主干旧：GET 会返回一些 key，
// 但 PUT 不认，报 `settings must NOT have additional properties`。
// 被拒的请求不会改动任何东西，所以逐个剔除可疑 key 来探测是安全的。
// 顺序按“最可能是新加的”排前面。
const SUSPECT_KEYS = [
  'binaryMode',
  'availableInMCP',
  'timeSavedMode',
  'timeSavedPerExecution',
  'redactionPolicy',
  'credentialResolverId',
  'customTelemetryTags',
];

const original = { ...(wf.settings ?? {}) };
let settings = { ...original };
const dropped = [];

for (;;) {
  try {
    tryUpdate(settings);
    break;
  } catch (e) {
    const msg = `${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}`;
    if (!/additional properties/i.test(msg)) throw e;

    const next = SUSPECT_KEYS.find((k) => k in settings);
    if (!next) {
      console.error('settings 里已经没有可剔除的候选 key 了，原始报错：\n' + msg);
      throw e;
    }
    delete settings[next];
    dropped.push(next);
  }
}

console.log(`\n已写入 ${changes.length} 处改动到 workflow ${WF_ID}`);
if (dropped.length) {
  console.log(
    `注意：该实例的 API 不接受这些 settings key，已从 PUT body 里剔除：${dropped.join(', ')}`,
  );
  console.log(`剔除前的值：${JSON.stringify(Object.fromEntries(dropped.map((k) => [k, original[k]])))}`);
}
