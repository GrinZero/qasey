export interface Session {
  subjectId: string;
  tenantId: string;
  roles: string[];
  email?: string;
  displayName?: string;
  isAdmin: boolean;
}

export interface OrganizationSelection {
  redirectTo: string;
  organizations: Array<{ id: string; displayName: string }>;
}

export interface AuthConfig {
  google: boolean;
  password: boolean;
  registration: boolean;
}

export interface AuthRedirect {
  redirectTo: string;
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
  changeSetId: string;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  pullRequestUrl?: string;
  error?: string;
  repository: { owner: string; repository: string; baseRef: string };
  artifacts: Artifact[];
}

export interface CaseHubCase {
  id: string; suitePath: string; title: string; activeVersionId?: string; proposedVersionIds: string[]; updatedAt: string;
}

export interface CaseHubChangeSet {
  id: string; status: string; revision: number; caseVersionIds: string[]; runId?: string; branch?: string; pullRequestUrl?: string;
  requirement: { goal: string; requirementSummary: string }; updatedAt: string;
}

export interface CaseHubCaseVersion {
  id: string; caseId: string; version: number; suitePath: string; title: string; description: string; priority: "P0" | "P1" | "P2" | "P3";
  preconditions: string[]; steps: Array<{ action: string; expected: string[] }>; tags: string[]; automationPath: string; contentHash: string; status: string;
}

export interface CaseHubResult {
  id: string; changeSetId: string; runId: string; caseId: string; caseVersionId: string; attempt: number; executionStatus: string; reviewStatus: string; feedback?: string; artifacts: Artifact[];
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

export interface ApiTokenRecord {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
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

export type TriggerConnectionStatus = "awaiting_webhook" | "active" | "disabled" | "error";

export interface TriggerConfigurationField {
  key: string;
  label: string;
  type: "text" | "secret" | "boolean";
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface TriggerProvider {
  id: string;
  name: string;
  description: string;
  category: "channel" | "webhook" | "schedule" | "event-source";
  configurationTitle: string;
  configurationDescription: string;
  fields: TriggerConfigurationField[];
  capabilities: {
    configurationUpdate: boolean;
    enableDisable: boolean;
    rebind: boolean;
    delete: boolean;
  };
}

export interface TriggerTarget {
  id: string;
  applicationId: string;
  kind: "agent" | "workflow";
  resourceId: string;
  name: string;
}

export interface TriggerConnection {
  id: string;
  providerId: string;
  providerName: string;
  displayName: string;
  status: TriggerConnectionStatus;
  statusDetail: string;
  revision: number;
  target: TriggerTarget;
  identity?: { label: string; value: string; context?: string };
  endpoint?: { label: string; url: string };
  setupFields?: { key: string; label: string; value: string; copyable?: boolean }[];
  configurationValues?: Record<string, string>;
  guidance?: { title: string; body: string; codes?: string[] };
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}
