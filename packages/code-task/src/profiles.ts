import { createHash } from "node:crypto";

export interface ExecutionProfile {
  id: "web-e2e-author" | "web-e2e-repair" | "web-e2e-verifier" | "code-review-readonly";
  useAgent: boolean;
  writable: boolean;
  permission: "allow-once" | "reject";
  allowedCheckIds: readonly string[];
  allowedEnvironmentKeys: readonly string[];
  environmentAliases?: Readonly<Record<string, string>>;
  initialAgentMode?: "read-only" | "agent";
}

const WEB_E2E_ENVIRONMENT_ALIASES = { QASEY_E2E_BASE_URL: "BASE_URL" } as const;
const MODEL_ENVIRONMENT_KEYS = ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
const WEB_E2E_ENVIRONMENT_KEYS = [
  ...MODEL_ENVIRONMENT_KEYS,
  "PLAYWRIGHT_BROWSERS_PATH",
  "QASEY_E2E_BASE_URL",
  "QASEY_E2E_STORAGE_STATE_PATH",
] as const;

const PROFILES: Record<ExecutionProfile["id"], ExecutionProfile> = {
  "web-e2e-author": {
    id: "web-e2e-author", useAgent: true, writable: true, permission: "allow-once",
    allowedCheckIds: ["repo-install", "playwright"],
    allowedEnvironmentKeys: WEB_E2E_ENVIRONMENT_KEYS,
    environmentAliases: WEB_E2E_ENVIRONMENT_ALIASES,
    initialAgentMode: "agent",
  },
  "web-e2e-repair": {
    id: "web-e2e-repair", useAgent: true, writable: true, permission: "allow-once",
    allowedCheckIds: ["repo-install", "playwright"],
    allowedEnvironmentKeys: WEB_E2E_ENVIRONMENT_KEYS,
    environmentAliases: WEB_E2E_ENVIRONMENT_ALIASES,
    initialAgentMode: "agent",
  },
  "web-e2e-verifier": {
    id: "web-e2e-verifier", useAgent: false, writable: false, permission: "reject",
    allowedCheckIds: ["repo-install", "playwright"],
    allowedEnvironmentKeys: ["PLAYWRIGHT_BROWSERS_PATH", "QASEY_E2E_BASE_URL", "QASEY_E2E_STORAGE_STATE_PATH"],
    environmentAliases: WEB_E2E_ENVIRONMENT_ALIASES,
  },
  "code-review-readonly": {
    id: "code-review-readonly", useAgent: true, writable: false, permission: "reject",
    allowedCheckIds: [], allowedEnvironmentKeys: MODEL_ENVIRONMENT_KEYS, initialAgentMode: "read-only",
  },
};

export function executionProfile(id: ExecutionProfile["id"]): ExecutionProfile {
  return PROFILES[id];
}

export function executionProfileHash(profile: ExecutionProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
