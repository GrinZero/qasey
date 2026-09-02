import { Actions, Button, Card, CardText, type CardElement } from "chat";
import type { DevRuntimeApprovalRecord } from "./dev-runtime-service.ts";

export function slackTunnelApprovalCard(input: {
  toolName: string;
  argsSummary: string;
  callbackUrl: string;
  runtimeId: string;
}): CardElement {
  return Card({
    title: `批准本地工具调用 · ${input.toolName}`,
    subtitle: `运行环境 ${input.runtimeId}`,
    children: [
      CardText(input.argsSummary || "该工具没有可展示的参数。"),
      Actions([
        Button({
          id: "qasey_local_approve",
          label: "Approve",
          style: "primary",
          callbackUrl: input.callbackUrl,
        }),
        Button({
          id: "qasey_local_decline",
          label: "Decline",
          style: "danger",
          callbackUrl: input.callbackUrl,
        }),
      ]),
    ],
  }) as CardElement;
}

export function slackTunnelApprovalDecisionCard(
  record: DevRuntimeApprovalRecord,
  decision: "approved" | "declined",
  userName?: string,
): CardElement {
  const actor = userName ? ` by ${userName}` : "";
  return Card({
    title: `${decision === "approved" ? "Approved" : "Declined"}${actor} · ${record.toolName}`,
    subtitle: `运行环境 ${record.runtimeId}`,
    children: [CardText(record.argsSummary || "该工具没有可展示的参数。")],
  }) as CardElement;
}

export function slackTunnelApprovalStatusCard(
  record: DevRuntimeApprovalRecord,
  status: "expired" | "runtime_disconnected",
): CardElement {
  return Card({
    title: `${status === "expired" ? "Expired" : "Runtime disconnected"} · ${record.toolName}`,
    subtitle: `运行环境 ${record.runtimeId}`,
    children: [CardText(record.argsSummary || "该工具没有可展示的参数。")],
  }) as CardElement;
}
