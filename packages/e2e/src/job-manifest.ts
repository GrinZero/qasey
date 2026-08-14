import type { E2ERun } from "../../contracts/src/index.ts";

export function buildRunnerJob(run: E2ERun, image: string) {
  const name = `qasey-${run.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48)}`;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, labels: { "app.kubernetes.io/name": "qasey-runner", "qasey.moego.pet/run-id": run.id } },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 0,
      activeDeadlineSeconds: 3600,
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "qasey-runner", "qasey.moego.pet/run-id": run.id } },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{
            name: "runner", image,
            args: ["worker", "run", run.id],
            env: [{ name: "QASEY_RUN_ID", value: run.id }],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "4", memory: "8Gi" } },
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }, { name: "tmp", mountPath: "/tmp" }],
          }],
          volumes: [{ name: "workspace", emptyDir: { sizeLimit: "20Gi" } }, { name: "tmp", emptyDir: {} }],
        },
      },
    },
  };
}

