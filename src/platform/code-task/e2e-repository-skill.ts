import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ChangedProjectPlaywrightVerificationSchema,
  RepositoryProfileSchema,
  type ChangedProjectPlaywrightVerification,
  type RepositoryProfile,
} from "../../../packages/contracts/src/index.ts";

const RepositorySkillReferenceSchema = z.object({
  version: z.literal(1),
  web: z.object({
    target: RepositoryProfileSchema,
    verification: ChangedProjectPlaywrightVerificationSchema,
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
  target: RepositoryProfile;
  verification: ChangedProjectPlaywrightVerification;
}

export function webE2EConfigurationFromSkill(configFile?: string): WebE2EConfiguration {
  const snapshot = repositoryReference(configFile).web;
  return { target: snapshot.target, verification: snapshot.verification };
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
  const verification = webE2EConfigurationFromSkill(configFile).verification;
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
  return affected.map(project => ({
    id: project.id,
    config: project.config,
    playwrightProject: project.playwrightProject,
    testFiles: changedPaths.filter(path => isWithin(path, project.testRoot) && /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path)),
  }));
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
