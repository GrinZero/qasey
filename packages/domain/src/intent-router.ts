import type { Intent, IntentRoute } from "../../contracts/src/index.ts";
import { IntentRouteSchema } from "../../contracts/src/index.ts";

const writeTargets: Record<Intent, IntentRoute["writeTarget"]> = {
  qa_quick_query: "none",
  qa_review: "none",
  case_create_full: "metersphere",
  case_maintain_fast: "metersphere",
  experience_read: "none",
  experience_write: "qa_experience",
  meta_or_out_of_scope: "none",
  unknown: "none",
  e2e_generate: "git",
  e2e_rerun: "none",
  e2e_repair: "git",
  e2e_status: "none",
};

export function sanitizeIntentRoute(candidate: unknown): IntentRoute {
  const parsed = IntentRouteSchema.safeParse(candidate);
  if (!parsed.success) return fallbackIntentRoute("Intent router returned invalid structured output");
  const route = parsed.data;
  return {
    ...route,
    writeTarget: writeTargets[route.intent],
    reason: route.reason.slice(0, 500),
  };
}

export function fallbackIntentRoute(reason: string): IntentRoute {
  return {
    version: 2,
    intent: "unknown",
    relation: "unknown",
    writeTarget: "none",
    depth: "quick",
    confidence: 0,
    reason: reason.slice(0, 500),
    routerStatus: "fallback",
  };
}

export function classifyIntentDeterministically(message: string, recentHistory: string[] = []): IntentRoute {
  const text = message.toLowerCase().trim();
  const combined = `${recentHistory.slice(-6).join("\n")}\n${text}`.toLowerCase();
  const followUp = /^(继续|再试试|重试|开权限了|go on|retry)\b/i.test(text);
  let intent: Intent = "unknown";
  let depth: IntentRoute["depth"] = "quick";

  if (/e2e|端到端|playwright|maestro/.test(text)) {
    if (/状态|进度|结果|status/.test(text)) intent = "e2e_status";
    else if (/重跑|rerun|再跑/.test(text)) intent = "e2e_rerun";
    else if (/修复|repair|fix/.test(text)) intent = "e2e_repair";
    else intent = "e2e_generate";
    depth = "deep";
  } else if (/新增.*经验|沉淀.*经验|编辑.*经验|写.*experience/.test(text)) {
    intent = "experience_write";
  } else if (/经验|experience/.test(text) && /查|读|看看|历史/.test(text)) {
    intent = "experience_read";
  } else if (/创建|生成|重做|新建/.test(text) && /用例|test case/.test(text)) {
    intent = "case_create_full";
    depth = "deep";
  } else if (/修改|补充|维护|重建|写入|重试/.test(text) && /用例|metersphere/.test(combined)) {
    intent = "case_maintain_fast";
    depth = "standard";
  } else if (/评审|review|分析.*风险|测试范围|覆盖.*缺口/.test(text)) {
    intent = "qa_review";
    depth = "deep";
  } else if (/你好|hello|能做什么|能力|帮助/.test(text)) {
    intent = "meta_or_out_of_scope";
  } else if (text.length > 0 && !followUp) {
    intent = "qa_quick_query";
  }

  return sanitizeIntentRoute({
    version: 2,
    intent,
    relation: followUp ? "follow_up" : "new",
    writeTarget: writeTargets[intent],
    depth,
    confidence: followUp && intent === "unknown" ? 0.35 : 0.75,
    reason: followUp ? "Current message is a follow-up; prior unresolved goal is required" : "Deterministic local routing",
    routerStatus: "ok",
  });
}

