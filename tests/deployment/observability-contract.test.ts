import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production observability contract", () => {
  it("ships actionable alerts for every required operational signal", async () => {
    const rules = await readFile("deploy/observability/prometheus-rules.yml", "utf8");
    for (const metric of [
      "qasey_dependency_ready",
      "qasey_deployment_mode_info",
      "qasey_sandbox_unavailable_replicas",
      "qasey_sandbox_sessions",
      "qasey_slack_queue_overload_total",
      "qasey_slack_queue_depth",
      "qasey_workflow_reconciled_total",
      "qasey_workflow_stuck_run_age_seconds",
      "qasey_model_cost_microusd_total",
      "qasey_http_requests_total",
      "qasey_http_request_duration_seconds_bucket",
      "qasey_traffic_rejected_total",
      "qasey_traffic_store_error_total",
      "qasey_worker_process_up",
      "qasey_worker_ready",
    ]) expect(rules).toContain(metric);
    expect(rules).toContain("QaseyHttpErrorBudgetFastBurn");
    expect(rules).toContain("QaseyHttpErrorBudgetSlowBurn");
    expect(rules).toContain("QaseyHttpP95LatencyHigh");
    expect(rules).toContain("QaseyScrapeTargetDown");
    expect(rules).toContain('up{job=~"qasey-(api|worker)"} == 0');
    expect(rules).toContain("QaseyWorkerMetricsMissing");
    expect(rules).toContain('qasey_deployment_mode_info{mode="distributed"}');
    expect(rules).toContain("absent_over_time(qasey_worker_process_up[5m])");
    expect(rules).toContain("QaseyWorkerProcessDown");
    expect(rules).toContain("QaseyWorkerNotReady");
    expect(rules).not.toMatch(/latest|token=|password=/iu);
  });

  it("validates rules with pinned promtool and documents authenticated scraping", async () => {
    const [runbook, workflow] = await Promise.all([
      readFile("docs/operations.md", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
    ]);
    expect(workflow).toMatch(/prom\/prometheus:v3\.5\.5@sha256:[a-f0-9]{64}/u);
    expect(workflow).toContain("check rules prometheus-rules.yml");
    expect(workflow).toContain("test rules prometheus-rules.test.yml");
    expect(runbook).toContain("GET /internal/metrics");
    expect(runbook).toContain("platform.metrics.read");
    expect(runbook).toContain("QASEY_INSTANCE_ID");
    expect(runbook).toContain("DD_VERSION");
    expect(runbook).toContain("QASEY_WORKER_METRICS_TOKEN");
    expect(runbook).toContain("raw-event");
  });
});
