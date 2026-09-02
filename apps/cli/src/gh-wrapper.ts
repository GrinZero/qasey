#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
process.exitCode = await runRealGh(args);

function runRealGh(arguments_: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.QASEY_REAL_GH_PATH ?? "/usr/bin/gh", arguments_, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
}
