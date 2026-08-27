import { execFileSync } from "node:child_process";

const roots = execFileSync("git", ["rev-list", "--max-parents=0", "--all"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

if (roots.length !== 1) {
  console.error(`Public history must have exactly one root commit; found ${roots.length}.`);
  process.exit(1);
}

let marker = "";
try {
  marker = execFileSync("git", ["show", `${roots[0]}:.public-origin`], { encoding: "utf8" }).trim();
} catch {
  // Report the actionable invariant below without leaking Git internals.
}

if (marker !== "qasey-sanitized-snapshot-v1") {
  console.error("The root commit is not a Qasey sanitized public snapshot.");
  process.exit(1);
}

console.log("Public history starts from the sanitized Qasey snapshot root.");
