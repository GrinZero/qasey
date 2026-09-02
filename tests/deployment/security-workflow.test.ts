import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyScript = resolve(projectRoot, "scripts/check-license-policy.mjs");
const gitleaksImage =
  "ghcr.io/gitleaks/gitleaks@sha256:aa036a2f4bdfe3cc3c55fa4326308efabb4a6be498c883c864fd1d0d5585438a";
const osvScannerImage =
  "ghcr.io/google/osv-scanner-action@sha256:2b2b9fbe57b14097fb6953577f2fbecf49941e2346c4eceb9f0852a9682ae868";

let workflow = "";

beforeAll(async () => {
  workflow = await readFile(resolve(projectRoot, ".github/workflows/security.yml"), "utf8");
});

async function runPolicy(
  inventory: unknown,
  options: { lockfilePath?: string; reviewsPath?: string } = {},
) {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "qasey-license-policy-"));
  const inventoryPath = join(fixtureDirectory, "redacted-inventory.json");
  const emptyReviewsPath = join(fixtureDirectory, "empty-reviews.json");
  const emptyLockfilePath = join(fixtureDirectory, "empty-lockfile.yaml");
  try {
    await Promise.all([
      writeFile(inventoryPath, JSON.stringify(inventory), "utf8"),
      writeFile(emptyReviewsPath, JSON.stringify({ schemaVersion: 1, reviews: [] }), "utf8"),
      writeFile(emptyLockfilePath, "lockfileVersion: '9.0'\n", "utf8"),
    ]);
    const result = spawnSync(
      process.execPath,
      [
        policyScript,
        "--inventory",
        inventoryPath,
        "--reviews",
        options.reviewsPath ?? emptyReviewsPath,
        "--lockfile",
        options.lockfilePath ?? emptyLockfilePath,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

const reviewedRepository = {
  type: "git",
  url: "git+https://github.com/mastra-ai/mastra.git",
  directory: "pubsub/redis-streams",
};

async function createReviewedFixture() {
  const root = await mkdtemp(join(tmpdir(), "qasey-reviewed-license-"));
  const virtualStorePath = join(root, "node_modules/.pnpm");
  const virtualEntry = "@mastra+redis-streams@0.3.0_reviewed-fixture";
  const packagePath = join(
    virtualStorePath,
    virtualEntry,
    "node_modules/@mastra/redis-streams",
  );
  const reviewsPath = join(root, "license-reviews.json");
  const lockfilePath = join(root, "pnpm-lock.yaml");
  const manifestPath = join(packagePath, "package.json");
  const licensePath = join(packagePath, "LICENSE.md");
  const license = "Apache License 2.0\nPublic redacted license-review fixture.\n";
  const integrity = `sha512-${createHash("sha512").update("public-redacted-tarball-fixture").digest("base64")}`;
  const manifest = {
    name: "@mastra/redis-streams",
    version: "0.3.0",
    repository: reviewedRepository,
  };
  const review = {
    name: "@mastra/redis-streams",
    version: "0.3.0",
    pnpmLockIntegrity: integrity,
    licenseFile: "LICENSE.md",
    licenseSha256: createHash("sha256").update(license).digest("hex"),
    expectedLicense: "Apache-2.0",
    repository: reviewedRepository,
  };
  const inventory = {
    Unknown: [
      {
        name: "@mastra/redis-streams",
        versions: ["0.3.0"],
        paths: [packagePath],
        license: "Unknown",
      },
    ],
  };

  await mkdir(join(packagePath, "dist"), { recursive: true });
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(manifest), "utf8"),
    writeFile(licensePath, license, "utf8"),
    writeFile(join(packagePath, "dist/index.js"), "export {};\n", "utf8"),
    writeFile(
      lockfilePath,
      `lockfileVersion: '9.0'\n\npackages:\n\n  '@mastra/redis-streams@0.3.0':\n    resolution: {integrity: ${integrity}}\n`,
      "utf8",
    ),
    writeFile(reviewsPath, JSON.stringify({ schemaVersion: 1, reviews: [review] }), "utf8"),
  ]);

  return {
    inventory,
    licensePath,
    lockfilePath,
    manifest,
    manifestPath,
    packagePath,
    review,
    reviewsPath,
    root,
    virtualStorePath,
  };
}

type ReviewedFixture = Awaited<ReturnType<typeof createReviewedFixture>>;

async function runReviewedPolicy(
  mutate?: (fixture: ReviewedFixture) => Promise<void> | void,
) {
  const fixture = await createReviewedFixture();
  try {
    await mutate?.(fixture);
    return await runPolicy(fixture.inventory, {
      lockfilePath: fixture.lockfilePath,
      reviewsPath: fixture.reviewsPath,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

describe("supply-chain security workflow", () => {
  it("pins every official action and scanner image immutably", () => {
    const actionReferences = [
      ...workflow.matchAll(/^\s*-\s*uses:\s+([^@\s]+)@([^\s]+)(?:\s+#.*)?$/gmu),
    ].map(([, action, reference]) => ({ action, reference }));
    const officialActions = new Set([
      "actions/checkout",
      "actions/dependency-review-action",
      "actions/setup-node",
      "github/codeql-action/analyze",
      "github/codeql-action/init",
      "pnpm/action-setup",
    ]);

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const { action, reference } of actionReferences) {
      expect(officialActions.has(action ?? "")).toBe(true);
      expect(reference).toMatch(/^[a-f0-9]{40}$/u);
    }
    expect(workflow.split(gitleaksImage)).toHaveLength(3);
    expect(workflow).toContain(osvScannerImage);
    expect(workflow).not.toContain(":latest");
    expect(workflow).not.toMatch(/ghcr\.io\/[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+/u);
  });

  it("scans both complete fetched history and an isolated current tracked tree", () => {
    const secretJob = workflow.slice(
      workflow.indexOf("\n  secret-scan:"),
      workflow.indexOf("\n  lockfile-vulnerability-scan:"),
    );

    expect(secretJob).toContain("fetch-depth: 0");
    expect(secretJob).toContain("git /repo --log-opts=--all --redact");
    expect(secretJob).toContain("git archive --format=tar HEAD");
    expect(secretJob).toContain("dir /repo --redact");
    expect(secretJob.match(/continue-on-error: true/gu)).toHaveLength(2);
    expect(secretJob).toContain("if: always()");
    expect(secretJob).toContain("HISTORY_SCAN_OUTCOME");
    expect(secretJob).toContain("CURRENT_TREE_SCAN_OUTCOME");
  });

  it("gates the pnpm lockfile with the pinned official OSV scanner", () => {
    const vulnerabilityJob = workflow.slice(
      workflow.indexOf("\n  lockfile-vulnerability-scan:"),
      workflow.indexOf("\n  license-policy:"),
    );

    expect(vulnerabilityJob).toContain(osvScannerImage);
    expect(vulnerabilityJob).toContain("scan source --lockfile=pnpm-lock.yaml --format=table");
    expect(vulnerabilityJob).toContain('${GITHUB_WORKSPACE}:/src:ro');
  });

  it("installs only the production closure without scripts before checking licenses", () => {
    const licenseJob = workflow.slice(
      workflow.indexOf("\n  license-policy:"),
      workflow.indexOf("\n  codeql:"),
    );

    expect(licenseJob).toContain("node-version: 24");
    expect(licenseJob).toContain("pnpm install --frozen-lockfile --prod --ignore-scripts");
    expect(licenseJob).toContain("node scripts/check-license-policy.mjs");
    expect(licenseJob.indexOf("pnpm install --frozen-lockfile --prod --ignore-scripts")).toBeLessThan(
      licenseJob.indexOf("node scripts/check-license-policy.mjs"),
    );
  });
});

describe("production license policy", () => {
  it("keeps the public review scoped to the exact redis-streams artifact", async () => {
    const config = JSON.parse(
      await readFile(resolve(projectRoot, "config/license-reviews.json"), "utf8"),
    ) as { reviews: Array<{ name: string; version: string }> };

    expect(config.reviews).toHaveLength(1);
    expect(config.reviews[0]).toMatchObject({
      name: "@mastra/redis-streams",
      version: "0.3.0",
    });
    expect(JSON.stringify(config)).not.toContain("@mastra/editor");
  });

  it("accepts the explicit allowlist and selectable allowed SPDX alternatives", async () => {
    const expressions = [
      "MIT",
      "Apache-2.0",
      "MIT AND MPL-2.0",
      "(Apache-2.0 OR BSD-3-Clause)",
      "(AFL-2.1 OR BSD-3-Clause)",
      "(WTFPL OR MIT)",
    ];
    const result = await runPolicy({
      fixture: expressions.map((license, index) => ({
        name: `fixture-permissive-${index}`,
        versions: ["1.0.0"],
        license,
      })),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`accepted ${expressions.length} production packages`);
    expect(result.stderr).toBe("");
  });

  it("rejects denylisted and conjunctive copyleft licenses", async () => {
    const result = await runPolicy({
      fixture: [
        { name: "fixture-gpl", versions: ["1.0.0"], license: "GPL-3.0-only" },
        { name: "fixture-agpl", versions: ["1.0.0"], license: "AGPL-3.0-only" },
        { name: "fixture-mixed", versions: ["1.0.0"], license: "MIT AND LGPL-3.0-only" },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rejected 3 of 3 production packages");
    expect(result.stderr).toContain("outside the allow policy");
  });

  it("fails closed for unknown, missing, and malformed license metadata", async () => {
    const result = await runPolicy({
      fixture: [
        {
          name: "fixture-unknown",
          versions: ["1.0.0"],
          license: "Unknown",
          paths: ["/redacted/not-logged"],
        },
        { name: "fixture-missing", versions: ["1.0.0"] },
        { name: "fixture-malformed", versions: ["1.0.0"], license: "MIT OR" },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rejected 3 of 3 production packages");
    expect(result.stderr).toContain("unknown identifier");
    expect(result.stderr).toContain("metadata is missing");
    expect(result.stderr).toContain("malformed or unsupported");
    expect(result.stderr).not.toContain("/redacted/not-logged");
  });

  it("fails closed when the production inventory is unexpectedly empty", async () => {
    const result = await runPolicy({});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production license inventory contains no packages");
  });

  it("accepts the single exact reviewed redis-streams artifact", async () => {
    const result = await runReviewedPolicy();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("with 1 exact reviewed override(s)");
    expect(result.stderr).toBe("");
  });

  it("repairs a stale pnpm peer suffix only when one exact virtual-store install exists", async () => {
    const repairedResult = await runReviewedPolicy((fixture) => {
      const inventoryEntry = fixture.inventory.Unknown[0];
      if (!inventoryEntry) throw new Error("reviewed fixture is missing its inventory entry");
      inventoryEntry.paths = [
        join(
          fixture.virtualStorePath,
          "@mastra+redis-streams@0.3.0_stale-peer-suffix",
          "node_modules/@mastra/redis-streams",
        ),
      ];
    });
    const ambiguousResult = await runReviewedPolicy(async (fixture) => {
      await mkdir(
        join(
          fixture.virtualStorePath,
          "@mastra+redis-streams@0.3.0_second-install",
          "node_modules/@mastra/redis-streams",
        ),
        { recursive: true },
      );
    });

    expect(repairedResult.status).toBe(0);
    expect(repairedResult.stdout).toContain("with 1 exact reviewed override(s)");
    expect(ambiguousResult.status).toBe(1);
    expect(ambiguousResult.stderr).toContain("exactly one pnpm virtual-store installation");
  });

  it("rejects tampered lock integrity and LICENSE.md hashes", async () => {
    const integrityResult = await runReviewedPolicy(async (fixture) => {
      fixture.review.pnpmLockIntegrity = `sha512-${createHash("sha512")
        .update("different-public-redacted-tarball")
        .digest("base64")}`;
      await writeFile(
        fixture.reviewsPath,
        JSON.stringify({ schemaVersion: 1, reviews: [fixture.review] }),
        "utf8",
      );
    });
    const licenseResult = await runReviewedPolicy(async (fixture) => {
      fixture.review.licenseSha256 = "0".repeat(64);
      await writeFile(
        fixture.reviewsPath,
        JSON.stringify({ schemaVersion: 1, reviews: [fixture.review] }),
        "utf8",
      );
    });

    expect(integrityResult.status).toBe(1);
    expect(integrityResult.stderr).toContain("lockfile integrity mismatch");
    expect(licenseResult.status).toBe(1);
    expect(licenseResult.stderr).toContain("LICENSE.md SHA-256 mismatch");
  });

  it("recursively rejects ee path segments and symbolic links", async () => {
    const eeResult = await runReviewedPolicy(async (fixture) => {
      await mkdir(join(fixture.packagePath, "dist/ee"));
      await writeFile(join(fixture.packagePath, "dist/ee/index.js"), "export {};\n", "utf8");
    });
    const symlinkResult = await runReviewedPolicy(async (fixture) => {
      await symlink("../LICENSE.md", join(fixture.packagePath, "dist/license-link"));
    });

    expect(eeResult.status).toBe(1);
    expect(eeResult.stderr).toContain("forbidden ee path segment");
    expect(symlinkResult.status).toBe(1);
    expect(symlinkResult.stderr).toContain("contains a symbolic link");
  });

  it("rejects manifest version and repository mismatches", async () => {
    const versionResult = await runReviewedPolicy(async (fixture) => {
      fixture.manifest.version = "0.3.1";
      await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), "utf8");
    });
    const repositoryResult = await runReviewedPolicy(async (fixture) => {
      fixture.manifest.repository = {
        ...reviewedRepository,
        directory: "public-redacted-mismatch",
      };
      await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), "utf8");
    });

    expect(versionResult.status).toBe(1);
    expect(versionResult.stderr).toContain("manifest name or version mismatch");
    expect(repositoryResult.status).toBe(1);
    expect(repositoryResult.stderr).toContain("repository mismatch");
  });

  it("rejects missing and multiple reviewed installations", async () => {
    const missingResult = await runReviewedPolicy((fixture) => {
      fixture.inventory.Unknown = [];
    });
    const multipleResult = await runReviewedPolicy((fixture) => {
      fixture.inventory.Unknown[0]?.paths.push(fixture.packagePath);
    });

    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain("must appear exactly once in the production inventory");
    expect(multipleResult.status).toBe(1);
    expect(multipleResult.stderr).toContain("exactly one absolute install path");
  });
});
