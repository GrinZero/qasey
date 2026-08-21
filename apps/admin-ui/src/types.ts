export interface Session {
  subjectId: string;
  tenantId: string;
  roles: string[];
  email?: string;
  isAdmin: boolean;
}

export interface CatalogEntry {
  applicationId: string;
  resourceType: "agent" | "workflow" | "scorer" | "channel" | "route";
  resourceId: string;
  permission: string;
  routePath?: string;
  routeMethod?: string;
}

export interface AgentApplication {
  id: string;
  name: string;
  description: string;
  category: string;
  capabilities: string[];
  homePath: string;
  accent: "indigo" | "teal" | "amber" | "coral" | "blue";
}

export type RunStatus =
  | "queued"
  | "preparing_workspace"
  | "authoring"
  | "author_running"
  | "repairing"
  | "clean_verifying"
  | "awaiting_qa"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Artifact {
  id: string;
  kind: "log" | "trace" | "video" | "screenshot" | "report" | "patch" | "trajectory";
  name: string;
  uri: string;
  contentType?: string;
}

export interface QaseyRun {
  id: string;
  status: RunStatus;
  framework: "playwright" | "maestro";
  platform: "web" | "app";
  sourceCaseIds: string[];
  createdAt: string;
  updatedAt: string;
  branch?: string;
  pullRequestUrl?: string;
  error?: string;
  repository: { owner: string; repository: string; baseRef: string };
  artifacts: Artifact[];
}

export interface AuditRecord {
  requestId: string;
  at?: string;
  subjectId?: string;
  resourceType: string;
  resourceId: string;
  action: string;
  decision: "allow" | "deny";
  reason: string;
}

export interface SandboxSessionState {
  sessionId: string;
  workspaceId: string;
  generation: number;
  ordinal: number;
  lastActivityAt: string;
  browser: { running: boolean; url?: string; title?: string };
  desktop: {
    running: boolean;
    available: boolean;
    display?: string;
    width?: number;
    height?: number;
    recording?: boolean;
    applications?: string[];
  };
}
