const { test } = require("/app/node_modules/@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("fixed-check descendants remain inside the task mount and PID namespace", async ({ browser }) => {
  const sibling = `/tmp/qasey-data/workspaces/${"b".repeat(64)}/repo/sibling-secret`;
  if (fs.existsSync("/tmp/qasey-host-sentinel")) throw new Error("host /tmp leaked into code task");
  if (fs.existsSync("/dev/qasey-host-device-sentinel")) throw new Error("host /dev leaked into code task");
  if (fs.existsSync(sibling)) throw new Error("sibling workspace leaked into code task");
  if (fs.existsSync("/app/package.json")) throw new Error("application root leaked into code task");
  if (fs.existsSync("../../control")) throw new Error("Code Task control state leaked into fixed-check namespace");
  if (fs.existsSync("../../artifacts")) throw new Error("Code Task final artifact root leaked into fixed-check namespace");
  if (!fs.statSync("/dev/null").isCharacterDevice() || !fs.statSync("/dev/urandom").isCharacterDevice()) {
    throw new Error("fixed-check namespace did not receive fresh character devices");
  }
  if (!fs.statSync("/dev/shm").isDirectory()) throw new Error("fixed-check namespace did not receive private shared memory");
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) throw new Error("model credential leaked into fixed-check environment");
  if (process.env.QASEY_GH_BROKER_URL || process.env.QASEY_GH_BROKER_TOKEN) throw new Error("repository broker capability leaked into fixed-check environment");
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const environment = fs.readFileSync(`/proc/${entry}/environ`, "utf8");
      if (environment.includes("QASEY_SANDBOX_CONTROL_KEY") || environment.includes("synthetic-model-key-for-")) {
        throw new Error("parent or model credentials leaked through /proc");
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  const workspace = fs.realpathSync(process.cwd());
  const commonDir = fs.realpathSync(path.resolve(workspace, execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()));
  if (commonDir !== workspace && !commonDir.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Code Task Git metadata points outside its isolated checkout");
  }
  if (fs.existsSync(path.join(workspace, ".git", "objects", "info", "alternates"))) {
    throw new Error("Code Task checkout references shared Git objects");
  }
  if (!fs.statSync("../reference/.git").isDirectory()) throw new Error("secondary read repository is not an independent checkout");
  let readOnlyWriteRejected = false;
  try { fs.writeFileSync("../reference/must-not-write", "forbidden"); }
  catch { readOnlyWriteRejected = true; }
  if (!readOnlyWriteRejected || fs.existsSync("../reference/must-not-write")) {
    throw new Error("secondary read repository accepted a write");
  }
  const page = await browser.newPage();
  await page.goto("data:text/html,<title>nested-code-task-browser</title>");
  if (await page.title() !== "nested-code-task-browser") throw new Error("nested fixed-check browser did not execute");
  await page.close();
  fs.writeFileSync("smoke/proof.txt", "task-isolation-ok\n", { mode: 0o600 });
});
