import { Card, CardText, Table, type CardElement } from "chat";
import type { EvidenceCompletionReceipt } from "../../../packages/domain/src/index.ts";

const MAX_ROWS_PER_TABLE = 100;

export interface MeterSphereSlackLinkConfig {
  baseUrl: string;
  projectId: string;
}

/** Build deterministic Slack-native data tables from trusted read-back data. */
export function slackCaseCompletionCards(
  receipt: EvidenceCompletionReceipt | undefined,
  config: MeterSphereSlackLinkConfig,
): CardElement[] {
  const operation = receipt?.caseOperation;
  if (!operation || operation.cases.length === 0) return [];

  const moduleUrl = `${config.baseUrl.replace(/\/$/u, "")}/#/track/case/all?projectId=${encodeURIComponent(config.projectId)}&moduleId=${encodeURIComponent(operation.moduleId)}`;
  const chunks = chunk(operation.cases, MAX_ROWS_PER_TABLE);
  return chunks.map((cases, index) => Card({
    title: chunks.length === 1
      ? `${operation.featureName} · MeterSphere 测试用例`
      : `${operation.featureName} · MeterSphere 测试用例 (${index + 1}/${chunks.length})`,
    subtitle: `新建 ${operation.createdCount} 条 · 更新 ${operation.updatedCount} 条 · 独立回查 ${operation.verifiedCount}/${operation.itemCount}`,
    children: [
      CardText(`<${moduleUrl}|打开 MeterSphere 模块>`),
      Table({
        caption: `${operation.featureName} 测试用例`,
        headers: ["ID", "用例名称", "优先级"],
        rows: cases.map(testCase => [String(testCase.num), testCase.name, testCase.priority]),
        pageSize: Math.min(10, cases.length),
      }),
    ],
  }) as CardElement);
}

function chunk<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}
