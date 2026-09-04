import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ChangedProjectPlaywrightVerificationSchema,
  E2EAuthenticationSchema,
  E2EProjectSkillPathSchema,
  E2ETestEnvironmentSchema,
  RepositoryProfileSchema,
  type CaseHubCaseProposal,
  type ChangedProjectPlaywrightVerification,
  type E2ETestEnvironment,
  type RepositoryProfile,
} from "../../../packages/contracts/src/index.ts";

const DEFAULT_TEST_FILE_SUFFIXES = [
  ".spec.ts", ".spec.tsx", ".spec.mts", ".spec.mtsx", ".spec.cts", ".spec.ctsx", ".spec.js", ".spec.jsx", ".spec.mjs", ".spec.mjsx", ".spec.cjs", ".spec.cjsx",
  ".test.ts", ".test.tsx", ".test.mts", ".test.mtsx", ".test.cts", ".test.ctsx", ".test.js", ".test.jsx", ".test.mjs", ".test.mjsx", ".test.cjs", ".test.cjsx",
] as const;
const RepositoryPlaywrightPathSchema = z.string().min(1).max(1_000)
  .refine(value => !value.startsWith("/") && !value.startsWith("\\"), "Playwright verification paths must be relative")
  .refine(value => !value.includes("\\"), "Playwright verification paths must use canonical POSIX separators")
  .refine(value => value.split("/").every(segment => segment !== "." && segment !== ".." && segment.length > 0), "Playwright verification paths cannot contain dot or empty segments");
const RepositoryPlaywrightProjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u).max(100),
  root: RepositoryPlaywrightPathSchema,
  testRoot: RepositoryPlaywrightPathSchema,
  testFileSuffixes: z.array(z.string().regex(/^\.[A-Za-z0-9._-]+$/u).max(100)).min(1).max(32)
    .default([...DEFAULT_TEST_FILE_SUFFIXES]),
  config: RepositoryPlaywrightPathSchema,
  playwrightProject: z.string().min(1).max(100),
}).strict();
const RepositoryPlaywrightVerificationSchema = z.object({
  strategy: z.literal("changed-project-playwright"),
  projects: z.array(RepositoryPlaywrightProjectSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  const verification = ChangedProjectPlaywrightVerificationSchema.safeParse(stripTestFileSuffixes(value));
  if (!verification.success) {
    for (const issue of verification.error.issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  }
});

const RepositorySkillReferenceSchema = z.object({
  version: z.literal(1),
  web: z.object({
    target: RepositoryProfileSchema.extend({
      e2eSkillPath: E2EProjectSkillPathSchema,
      e2eAuthentication: E2EAuthenticationSchema,
    }).strict(),
    environment: E2ETestEnvironmentSchema,
    verification: RepositoryPlaywrightVerificationSchema,
    contextRepositories: z.array(z.unknown()).default([]),
  }).strict(),
  app: z.object({ status: z.literal("deferred"), target: z.object({ owner: z.string(), repository: z.string() }) }),
}).strict().superRefine((value, context) => {
  const { target, verification } = value.web;
  for (const [index, allowedPath] of target.allowedPaths.entries()) {
    if (!verification.projects.some(project => isWithin(allowedPath, project.root))) {
      context.addIssue({
        code: "custom",
        path: ["web", "target", "allowedPaths", index],
        message: "Every writable path must be covered by a fixed Playwright project root",
      });
    }
  }
  for (const [index, project] of verification.projects.entries()) {
    if (!target.allowedPaths.some(allowedPath => isWithin(allowedPath, project.root))) {
      context.addIssue({
        code: "custom",
        path: ["web", "verification", "projects", index, "root"],
        message: "Every fixed Playwright project must cover at least one writable path",
      });
    }
  }
  if (!verification.projects.some(project => isWithin(target.e2eAuthentication.setupPath, project.root))) {
    context.addIssue({
      code: "custom",
      path: ["web", "target", "e2eAuthentication", "setupPath"],
      message: "The Playwright authentication setup must be inside a fixed verification project root",
    });
  }
});

function repositoryReference(configFile?: string) {
  const path = resolve(configFile ?? process.env.QASEY_E2E_REPOSITORY_CONFIG_FILE ?? "config/e2e-repository.json");
  if (!existsSync(path)) {
    throw new Error(
      "Web E2E repository is not configured. Copy config/e2e-repository.example.json "
      + "to config/e2e-repository.json and describe a repository you are authorized to access.",
    );
  }
  return RepositorySkillReferenceSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export interface WebE2EConfiguration {
  target: RepositoryProfile & {
    e2eSkillPath: string;
    e2eAuthentication: { strategy: "repository-playwright-setup"; setupPath: string; setupProject: string; requiredEnvironment: string[] };
  };
  environment: E2ETestEnvironment;
  verification: ChangedProjectPlaywrightVerification;
  automationPathPolicy: WebE2EAutomationPathPolicy;
}

export interface WebE2EAutomationPathPolicy {
  projects: Array<{ id: string; testRoot: string; testFileSuffixes: string[] }>;
}

export function webE2EConfigurationFromSkill(configFile?: string): WebE2EConfiguration {
  const snapshot = repositoryReference(configFile).web;
  return {
    target: snapshot.target,
    environment: snapshot.environment,
    verification: ChangedProjectPlaywrightVerificationSchema.parse(stripTestFileSuffixes(snapshot.verification)),
    automationPathPolicy: {
      projects: snapshot.verification.projects.map(project => ({
        id: project.id,
        testRoot: project.testRoot,
        testFileSuffixes: project.testFileSuffixes,
      })),
    },
  };
}

export function webE2ERepositoryFromSkill(configFile?: string): RepositoryProfile {
  return webE2EConfigurationFromSkill(configFile).target;
}

export function webE2EVerificationFromSkill(configFile?: string) {
  return webE2EConfigurationFromSkill(configFile).verification;
}

export interface WebE2EPlaywrightPlan {
  id: string;
  config: string;
  playwrightProject: string;
  testFiles: string[];
}

export function webE2EPlaywrightPlans(changedPaths: string[], configFile?: string): WebE2EPlaywrightPlan[] {
  const configuration = webE2EConfigurationFromSkill(configFile);
  const { verification } = configuration;
  const uncovered = changedPaths.filter(path => !verification.projects.some(project => isWithin(path, project.root)));
  if (uncovered.length > 0) {
    throw new Error(`Changed paths are not covered by a fixed Playwright project: ${uncovered.join(", ")}`);
  }
  const affected = verification.projects.filter(project =>
    changedPaths.some(path => isWithin(path, project.root)),
  );
  if (affected.length === 0) {
    throw new Error(`No fixed Playwright project matches changed paths: ${changedPaths.join(", ") || "none"}`);
  }
  return affected.map(project => {
    const policy = configuration.automationPathPolicy.projects.find(candidate => candidate.id === project.id);
    if (!policy) throw new Error(`Playwright project ${project.id} has no local discovery policy`);
    return {
      id: project.id,
      config: project.config,
      playwrightProject: project.playwrightProject,
      testFiles: changedPaths.filter(path => isWithin(path, project.testRoot) && policy.testFileSuffixes.some(suffix => path.endsWith(suffix))),
    };
  });
}

export function assertWebE2EAutomationPaths(
  proposals: Pick<CaseHubCaseProposal, "automationPath">[],
  policy: WebE2EAutomationPathPolicy,
): void {
  for (const proposal of proposals) {
    const project = policy.projects.find(candidate => isWithin(proposal.automationPath, candidate.testRoot));
    if (!project) {
      throw new Error(`Case automationPath is outside the configured Playwright test roots: ${proposal.automationPath}`);
    }
    if (!project.testFileSuffixes.some(suffix => proposal.automationPath.endsWith(suffix))) {
      throw new Error(
        `Case automationPath is not discoverable by Playwright project ${project.id}: ${proposal.automationPath}; `
        + `expected one of ${project.testFileSuffixes.join(", ")}`,
      );
    }
  }
}

function stripTestFileSuffixes(verification: {
  strategy: "changed-project-playwright";
  projects: Array<z.infer<typeof RepositoryPlaywrightProjectSchema>>;
}): ChangedProjectPlaywrightVerification {
  return {
    strategy: verification.strategy,
    projects: verification.projects.map(({ testFileSuffixes: _testFileSuffixes, ...project }) => project),
  };
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
