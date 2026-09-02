import type { ReadinessSnapshot } from "../storage/readiness.ts";
import type { SandboxPoolCapacity } from "../workspace/sandbox-client.ts";

interface QueueSeries {
  tenantId: string;
  channel: string;
  partition: string;
  depth: number;
}

interface StuckRunSeries {
  tenantId: string;
  runId: string;
  ageSeconds: number;
}

interface ModelUsageSeries {
  tenantId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
}

interface HttpRequestSeries {
  applicationId: string;
  routeId: string;
  method: string;
  statusClass: string;
  count: number;
  durationSeconds: number;
  buckets: number[];
}

const HTTP_DURATION_BUCKETS_SECONDS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

export interface ProductionSignalRenderOptions {
  instanceId: string;
  version: string;
  role: "api" | "worker";
  deploymentMode: "standalone" | "distributed";
  readiness: ReadinessSnapshot;
  modelCostReportingConfigured?: boolean;
  sandbox?: SandboxPoolCapacity;
}

/**
 * A deliberately small, bounded metrics registry for operational signals that
 * are not already emitted by the runtime. Labels are identifiers only; prompts,
 * errors, URLs, and credentials are never accepted by this API.
 */
export class ProductionSignals {
  private readonly queues = new Map<string, QueueSeries>();
  private readonly stuckRuns = new Map<string, StuckRunSeries>();
  private readonly modelUsage = new Map<string, ModelUsageSeries>();
  private readonly httpRequests = new Map<string, HttpRequestSeries>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly maxSeries = 10_000) {
    if (!Number.isInteger(maxSeries) || maxSeries < 1) throw new RangeError("Metrics series limit must be positive");
  }

  setQueueDepth(input: { tenantId: string; channel: string; partition: string; depth: number }): void {
    const series = {
      tenantId: metricIdentifier(input.tenantId, "tenantId"),
      channel: metricIdentifier(input.channel, "channel"),
      partition: metricIdentifier(input.partition, "partition"),
      depth: metricValue(input.depth, "queue depth"),
    };
    const key = seriesKey(series.tenantId, series.channel, series.partition);
    if (series.depth === 0) this.queues.delete(key);
    else this.setBounded(this.queues, key, series);
  }

  incrementQueueOverload(tenantId: string, channel: string): void {
    this.incrementCounter("queue_overload", metricIdentifier(tenantId, "tenantId"), metricIdentifier(channel, "channel"));
  }

  setStuckRun(input: { tenantId: string; runId: string; ageSeconds: number }): void {
    const series = {
      tenantId: metricIdentifier(input.tenantId, "tenantId"),
      runId: metricIdentifier(input.runId, "runId"),
      ageSeconds: metricValue(input.ageSeconds, "stuck run age"),
    };
    this.setBounded(this.stuckRuns, seriesKey(series.tenantId, series.runId), series);
  }

  clearStuckRun(tenantId: string, runId: string): void {
    this.stuckRuns.delete(seriesKey(metricIdentifier(tenantId, "tenantId"), metricIdentifier(runId, "runId")));
  }

  incrementReconciled(tenantId: string, outcome: "failed" | "conflicted"): void {
    this.incrementCounter("reconciled", metricIdentifier(tenantId, "tenantId"), outcome);
  }

  incrementTrafficRejected(input: {
    policy: "standard" | "expensive";
    scope: "tenant" | "subject";
    reason: "fixed_window" | "concurrency";
  }): void {
    this.incrementCounter("traffic_rejected", input.policy, input.scope, input.reason);
  }

  incrementTrafficStoreError(operation: "admit" | "release"): void {
    this.incrementCounter("traffic_store_error", operation);
  }

  addModelUsage(input: {
    tenantId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costMicrousd?: number;
  }): void {
    const tenantId = metricIdentifier(input.tenantId, "tenantId");
    const model = metricIdentifier(input.model, "model");
    const key = seriesKey(tenantId, model);
    const current = this.modelUsage.get(key) ?? { tenantId, model, inputTokens: 0, outputTokens: 0, costMicrousd: 0 };
    current.inputTokens += metricValue(input.inputTokens, "input token count");
    current.outputTokens += metricValue(input.outputTokens, "output token count");
    current.costMicrousd += metricValue(input.costMicrousd ?? 0, "model cost");
    this.setBounded(this.modelUsage, key, current);
  }

  observeHttpRequest(input: {
    applicationId: string;
    routeId: string;
    method: string;
    status: number;
    durationMs: number;
  }): void {
    const applicationId = metricIdentifier(input.applicationId, "applicationId");
    const routeId = metricIdentifier(input.routeId, "routeId");
    const method = metricIdentifier(input.method.toUpperCase(), "method");
    if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
      throw new Error("Invalid HTTP status");
    }
    const statusClass = `${Math.floor(input.status / 100)}xx`;
    const durationSeconds = metricValue(input.durationMs, "HTTP request duration") / 1_000;
    const key = seriesKey(applicationId, routeId, method, statusClass);
    const current = this.httpRequests.get(key) ?? {
      applicationId,
      routeId,
      method,
      statusClass,
      count: 0,
      durationSeconds: 0,
      buckets: HTTP_DURATION_BUCKETS_SECONDS.map(() => 0),
    };
    current.count += 1;
    current.durationSeconds += durationSeconds;
    HTTP_DURATION_BUCKETS_SECONDS.forEach((upperBound, index) => {
      if (durationSeconds <= upperBound) current.buckets[index] = (current.buckets[index] ?? 0) + 1;
    });
    this.setBounded(this.httpRequests, key, current);
  }

  render(options: ProductionSignalRenderOptions): string {
    const base = {
      instance: metricIdentifier(options.instanceId, "instanceId"),
      role: options.role,
      version: metricIdentifier(options.version, "version"),
    };
    const lines = [
      "# HELP qasey_build_info Build and process identity.",
      "# TYPE qasey_build_info gauge",
      sample("qasey_build_info", base, 1),
      "# HELP qasey_deployment_mode_info Deployment topology expected by this process.",
      "# TYPE qasey_deployment_mode_info gauge",
      sample("qasey_deployment_mode_info", { ...base, mode: options.deploymentMode }, 1),
      "# HELP qasey_model_cost_reporting_configured Whether both deployment-specific model cost rates are configured.",
      "# TYPE qasey_model_cost_reporting_configured gauge",
      sample("qasey_model_cost_reporting_configured", base, options.modelCostReportingConfigured ? 1 : 0),
      "# HELP qasey_dependency_ready Whether a required process dependency is ready.",
      "# TYPE qasey_dependency_ready gauge",
      ...Object.entries(options.readiness.dependencies).sort(([left], [right]) => left.localeCompare(right))
        .map(([dependency, state]) => sample("qasey_dependency_ready", { ...base, dependency }, state === "ready" ? 1 : 0)),
      "# HELP qasey_slack_queue_depth Accepted Slack deliveries waiting for processing.",
      "# TYPE qasey_slack_queue_depth gauge",
      ...[...this.queues.values()].map(value => sample("qasey_slack_queue_depth", {
        ...base, tenant: value.tenantId, channel: value.channel, partition: value.partition,
      }, value.depth)),
      "# HELP qasey_slack_queue_overload_total Slack deliveries rejected before admission because the queue was full.",
      "# TYPE qasey_slack_queue_overload_total counter",
      ...this.counterSamples("queue_overload", "qasey_slack_queue_overload_total", base, ["tenant", "channel"]),
      "# HELP qasey_workflow_stuck_run_age_seconds Age of a run selected by the stale-run reconciler.",
      "# TYPE qasey_workflow_stuck_run_age_seconds gauge",
      ...[...this.stuckRuns.values()].map(value => sample("qasey_workflow_stuck_run_age_seconds", {
        ...base, tenant: value.tenantId, run: value.runId,
      }, value.ageSeconds)),
      "# HELP qasey_workflow_reconciled_total Stale workflow reconciliation outcomes.",
      "# TYPE qasey_workflow_reconciled_total counter",
      ...this.counterSamples("reconciled", "qasey_workflow_reconciled_total", base, ["tenant", "outcome"]),
      "# HELP qasey_model_input_tokens_total Model input tokens attributed to a tenant.",
      "# TYPE qasey_model_input_tokens_total counter",
      ...[...this.modelUsage.values()].map(value => sample("qasey_model_input_tokens_total", { ...base, tenant: value.tenantId, model: value.model }, value.inputTokens)),
      "# HELP qasey_model_output_tokens_total Model output tokens attributed to a tenant.",
      "# TYPE qasey_model_output_tokens_total counter",
      ...[...this.modelUsage.values()].map(value => sample("qasey_model_output_tokens_total", { ...base, tenant: value.tenantId, model: value.model }, value.outputTokens)),
      "# HELP qasey_model_cost_microusd_total Model cost in millionths of a US dollar.",
      "# TYPE qasey_model_cost_microusd_total counter",
      ...[...this.modelUsage.values()].map(value => sample("qasey_model_cost_microusd_total", { ...base, tenant: value.tenantId, model: value.model }, value.costMicrousd)),
      "# HELP qasey_http_requests_total Authorized and rejected HTTP requests by bounded route identity.",
      "# TYPE qasey_http_requests_total counter",
      ...[...this.httpRequests.values()].map(value => sample("qasey_http_requests_total", httpLabels(base, value), value.count)),
      "# HELP qasey_http_request_duration_seconds End-to-end HTTP request duration.",
      "# TYPE qasey_http_request_duration_seconds histogram",
      ...[...this.httpRequests.values()].flatMap(value => [
        ...HTTP_DURATION_BUCKETS_SECONDS.map((upperBound, index) => sample(
          "qasey_http_request_duration_seconds_bucket",
          { ...httpLabels(base, value), le: String(upperBound) },
          value.buckets[index] ?? 0,
        )),
        sample("qasey_http_request_duration_seconds_bucket", { ...httpLabels(base, value), le: "+Inf" }, value.count),
        sample("qasey_http_request_duration_seconds_sum", httpLabels(base, value), value.durationSeconds),
        sample("qasey_http_request_duration_seconds_count", httpLabels(base, value), value.count),
      ]),
      "# HELP qasey_traffic_rejected_total Requests rejected by platform traffic governance.",
      "# TYPE qasey_traffic_rejected_total counter",
      ...this.counterSamples("traffic_rejected", "qasey_traffic_rejected_total", base, ["policy", "scope", "reason"]),
      "# HELP qasey_traffic_store_error_total Traffic-governance storage operations that failed.",
      "# TYPE qasey_traffic_store_error_total counter",
      ...this.counterSamples("traffic_store_error", "qasey_traffic_store_error_total", base, ["operation"]),
    ];
    if (options.sandbox) {
      lines.push(
        "# HELP qasey_sandbox_sessions Sandbox pool session capacity.",
        "# TYPE qasey_sandbox_sessions gauge",
        sample("qasey_sandbox_sessions", { ...base, state: "active" }, options.sandbox.active),
        sample("qasey_sandbox_sessions", { ...base, state: "available" }, options.sandbox.available),
        sample("qasey_sandbox_sessions", { ...base, state: "maximum" }, options.sandbox.maximum),
        "# HELP qasey_sandbox_unavailable_replicas Sandbox replicas whose capacity probe failed.",
        "# TYPE qasey_sandbox_unavailable_replicas gauge",
        sample("qasey_sandbox_unavailable_replicas", base, options.sandbox.unavailableReplicas),
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private incrementCounter(prefix: string, ...labels: string[]): void {
    const key = seriesKey(prefix, ...labels);
    if (!this.counters.has(key) && this.totalSeries() >= this.maxSeries) throw new Error("Metrics series limit exceeded");
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  private counterSamples(prefix: string, name: string, base: Record<string, string>, labelNames: string[]): string[] {
    return [...this.counters]
      .filter(([key]) => key.startsWith(`${prefix}\0`))
      .map(([key, value]) => {
        const labels = key.split("\0").slice(1);
        return sample(name, { ...base, ...Object.fromEntries(labelNames.map((label, index) => [label, labels[index] ?? "unknown"])) }, value);
      });
  }

  private setBounded<T>(target: Map<string, T>, key: string, value: T): void {
    if (!target.has(key) && this.totalSeries() >= this.maxSeries) throw new Error("Metrics series limit exceeded");
    target.set(key, value);
  }

  private totalSeries(): number {
    return this.queues.size + this.stuckRuns.size + this.modelUsage.size + this.httpRequests.size + this.counters.size;
  }
}

export const productionSignals = new ProductionSignals();

function seriesKey(...values: string[]): string { return values.join("\0"); }

function metricIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`Invalid metrics ${name}`);
  }
  return normalized;
}

function metricValue(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid metrics ${name}`);
  return value;
}

function sample(name: string, labels: Record<string, string>, value: number): string {
  const rendered = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, label]) => `${key}="${escapeLabel(label)}"`).join(",");
  return `${name}{${rendered}} ${value}`;
}

function httpLabels(base: Record<string, string>, value: HttpRequestSeries): Record<string, string> {
  return {
    ...base,
    application: value.applicationId,
    route: value.routeId,
    method: value.method,
    status_class: value.statusClass,
  };
}

function escapeLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');
}
