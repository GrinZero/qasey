import { describe, expect, it } from "vitest";
import { ProductionSignals } from "../../src/platform/observability/production-signals.ts";

describe("production operational signals", () => {
  it("renders dependency, capacity, queue, recovery, and model signals without content", () => {
    const signals = new ProductionSignals();
    signals.setQueueDepth({ tenantId: "tenant-a", channel: "slack", partition: "thread-1", depth: 3 });
    signals.incrementQueueOverload("tenant-a", "slack");
    signals.setStuckRun({ tenantId: "tenant-a", runId: "run-1", ageSeconds: 181 });
    signals.incrementReconciled("tenant-a", "failed");
    signals.addModelUsage({ tenantId: "tenant-a", model: "model-a", inputTokens: 100, outputTokens: 20, costMicrousd: 42 });
    signals.observeHttpRequest({ applicationId: "qasey", routeId: "task-create", method: "post", status: 202, durationMs: 240 });
    signals.observeHttpRequest({ applicationId: "qasey", routeId: "task-create", method: "POST", status: 202, durationMs: 600 });
    signals.incrementTrafficRejected({ policy: "expensive", scope: "tenant", reason: "concurrency" });
    signals.incrementTrafficStoreError("release");

    const metrics = signals.render({
      instanceId: "instance-a",
      version: "sha256:release",
      role: "worker",
      deploymentMode: "distributed",
      modelCostReportingConfigured: true,
      readiness: { ready: false, dependencies: { postgres: "ready", redis: "not_ready" } },
      sandbox: { replicas: 2, active: 3, available: 5, maximum: 8, unavailableReplicas: 0 },
    });

    expect(metrics).toContain('qasey_dependency_ready{dependency="redis",instance="instance-a",role="worker",version="sha256:release"} 0');
    expect(metrics).toContain('qasey_deployment_mode_info{instance="instance-a",mode="distributed",role="worker",version="sha256:release"} 1');
    expect(metrics).toContain('qasey_slack_queue_depth{channel="slack",instance="instance-a",partition="thread-1",role="worker",tenant="tenant-a",version="sha256:release"} 3');
    expect(metrics).toContain('qasey_workflow_stuck_run_age_seconds{instance="instance-a",role="worker",run="run-1",tenant="tenant-a",version="sha256:release"} 181');
    expect(metrics).toContain('qasey_model_cost_microusd_total{instance="instance-a",model="model-a",role="worker",tenant="tenant-a",version="sha256:release"} 42');
    expect(metrics).toContain('qasey_model_cost_reporting_configured{instance="instance-a",role="worker",version="sha256:release"} 1');
    expect(metrics).toContain('qasey_sandbox_sessions{instance="instance-a",role="worker",state="available",version="sha256:release"} 5');
    expect(metrics).toContain('qasey_http_requests_total{application="qasey",instance="instance-a",method="POST",role="worker",route="task-create",status_class="2xx",version="sha256:release"} 2');
    expect(metrics).toContain('qasey_http_request_duration_seconds_bucket{application="qasey",instance="instance-a",le="0.5",method="POST",role="worker",route="task-create",status_class="2xx",version="sha256:release"} 1');
    expect(metrics).toContain('qasey_http_request_duration_seconds_count{application="qasey",instance="instance-a",method="POST",role="worker",route="task-create",status_class="2xx",version="sha256:release"} 2');
    expect(metrics).toContain('qasey_traffic_rejected_total{instance="instance-a",policy="expensive",reason="concurrency",role="worker",scope="tenant",version="sha256:release"} 1');
    expect(metrics).toContain('qasey_traffic_store_error_total{instance="instance-a",operation="release",role="worker",version="sha256:release"} 1');
    expect(metrics).not.toContain("prompt");
  });

  it("removes empty queues and bounds high-cardinality series", () => {
    const signals = new ProductionSignals(1);
    signals.setQueueDepth({ tenantId: "tenant-a", channel: "slack", partition: "one", depth: 1 });
    expect(() => signals.setStuckRun({ tenantId: "tenant-a", runId: "run-1", ageSeconds: 60 })).toThrow(/series limit/u);
    signals.setQueueDepth({ tenantId: "tenant-a", channel: "slack", partition: "one", depth: 0 });
    expect(() => signals.setStuckRun({ tenantId: "tenant-a", runId: "run-1", ageSeconds: 60 })).not.toThrow();
  });

  it("rejects unsafe label identifiers and metric values", () => {
    const signals = new ProductionSignals();
    expect(() => signals.incrementQueueOverload("tenant\nleak", "slack")).toThrow(/tenantId/u);
    expect(() => signals.addModelUsage({ tenantId: "tenant", model: "model", inputTokens: -1, outputTokens: 0 })).toThrow(/input token/u);
    expect(() => signals.observeHttpRequest({ applicationId: "qasey", routeId: "task", method: "POST", status: 700, durationMs: 1 })).toThrow(/status/u);
  });
});
