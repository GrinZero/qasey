import type { ArtifactRef } from "../../contracts/src/index.ts";
import { runSafeCommand } from "./process.ts";
import type { WorkspaceRef } from "./workspace.ts";

export interface CuaObservation { summary: string; artifacts: ArtifactRef[]; }

export class CuaFallback {
  async observe(workspace: WorkspaceRef, runId: string, task: string): Promise<CuaObservation> {
    const result = await runSafeCommand({
      executable: "cua-driver",
      args: ["call", "observe", "--task", task],
      cwd: workspace.root,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0) throw new Error(`Cua fallback failed: ${result.stderr.slice(-1000)}`);
    return {
      summary: result.stdout.slice(-8000),
      artifacts: [{ id: `${runId}:cua`, kind: "trajectory", name: "cua-trajectory", uri: `cua://${runId}` }],
    };
  }
}

