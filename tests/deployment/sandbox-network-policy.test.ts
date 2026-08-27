import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("sandbox Kubernetes network boundary", () => {
  it("denies general DNS and sends the sandbox only to a reserved proxy Service IP", async () => {
    const manifest = await readFile(resolve(projectRoot, "deploy/kubernetes/sandbox-network-policy.yaml"), "utf8");

    expect(manifest).toContain("name: qasey-sandbox-default-deny");
    expect(manifest).toContain("ingress: []\n  egress: []");
    expect(manifest).not.toContain("kube-dns");
    expect(manifest).not.toMatch(/\bport:\s*53\b/u);
    expect(manifest).toContain("name: qasey-sandbox-egress-proxy");
    expect(manifest).toContain("clusterIP: 10.96.0.50");
    expect(manifest).toContain("value: http://10.96.0.50:3128");
    expect(manifest).toContain("app.kubernetes.io/name: qasey-sandbox-egress-proxy");
    expect(manifest).toMatch(/protocol: TCP\n\s+port: 3128/u);
  });

  it("keeps the untrusted pod non-root, tokenless, capability-free, and resource-bounded", async () => {
    const manifest = await readFile(resolve(projectRoot, "deploy/kubernetes/sandbox-network-policy.yaml"), "utf8");
    const deployment = manifest.slice(manifest.indexOf("apiVersion: apps/v1"));
    const sandboxContainer = deployment.slice(
      deployment.indexOf("        - name: sandbox\n"),
      deployment.indexOf("      # Standard Kubernetes resources"),
    );

    expect(deployment).toContain("automountServiceAccountToken: false");
    expect(deployment).toContain("terminationGracePeriodSeconds: 30");
    expect(deployment).toContain("runtimeClassName: qasey-sandbox-userns");
    expect(deployment).toContain('qasey.io/sandbox-userns: "true"');
    expect(deployment).toContain("key: qasey.io/sandbox");
    expect(deployment).toContain("hostUsers: false");
    expect(deployment).toContain("runAsNonRoot: true");
    expect(deployment).not.toMatch(/host(?:Network|PID|IPC): true/u);
    expect(sandboxContainer).toContain("allowPrivilegeEscalation: false");
    expect(sandboxContainer).toContain("readOnlyRootFilesystem: true");
    expect(sandboxContainer).toContain("procMount: Unmasked");
    expect(sandboxContainer).toContain("seccompProfile:\n              type: Localhost\n              localhostProfile: profiles/qasey-bwrap.json");
    expect(sandboxContainer).toContain("appArmorProfile:\n              type: Localhost\n              localhostProfile: qasey-bwrap");
    expect(sandboxContainer).toContain("capabilities:\n              drop:\n                - ALL");
    expect(sandboxContainer).not.toContain("privileged: true");
    expect(sandboxContainer).toContain("startupProbe:\n            httpGet:\n              path: /readyz\n              port: http");
    expect(sandboxContainer).toContain("readinessProbe:\n            httpGet:\n              path: /readyz\n              port: http");
    expect(sandboxContainer).toContain("livenessProbe:\n            httpGet:\n              path: /healthz\n              port: http");
    expect(sandboxContainer).toContain("failureThreshold: 60");
    expect(sandboxContainer).toContain("ephemeral-storage: 8Gi");
    expect(sandboxContainer).toContain("name: QASEY_IMAGE_DIGEST");
    expect(sandboxContainer).toContain("value: sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(deployment).toContain("sizeLimit: 6Gi");
  });
});
