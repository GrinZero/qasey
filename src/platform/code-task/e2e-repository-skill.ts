import { z } from "zod";
import { RepositoryProfileSchema, type RepositoryProfile } from "../../../packages/contracts/src/index.ts";
import repositoryReference from "../../mastra/agents/qasey-main/skills/e2e-lifecycle/references/repositories.json" with { type: "json" };

const RepositorySkillReferenceSchema = z.object({
  version: z.literal(1),
  web: z.object({
    target: RepositoryProfileSchema,
    verification: z.object({
      strategy: z.literal("changed-project-playwright"),
      projects: z.array(z.object({
        id: z.string().regex(/^[a-z0-9-]+$/u),
        root: z.string().min(1),
        testRoot: z.string().min(1),
        config: z.string().min(1),
        playwrightProject: z.string().min(1),
      }).strict()).min(1),
    }).strict(),
    contextRepositories: z.array(z.unknown()).default([]),
  }).strict(),
  app: z.object({ status: z.literal("deferred"), target: z.object({ owner: z.string(), repository: z.string() }) }),
}).strict();

const parsedReference = RepositorySkillReferenceSchema.parse(repositoryReference);

export function webE2ERepositoryFromSkill(): RepositoryProfile {
  return parsedReference.web.target;
}

export function webE2EVerificationFromSkill() {
  return parsedReference.web.verification;
}

export interface WebE2EPlaywrightPlan {
  id: string;
  config: string;
  playwrightProject: string;
  testFiles: string[];
}

export function webE2EPlaywrightPlans(changedPaths: string[]): WebE2EPlaywrightPlan[] {
  const affected = parsedReference.web.verification.projects.filter(project =>
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
  return path === root || path.startsWith(`${root}/`);
}
