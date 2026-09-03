import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const target = process.env.BASE_URL ?? "http://localhost:4111";
const targetHash = createHash("sha256").update(target).digest("hex").slice(0, 16);

export const authStatePath = join(tmpdir(), "qasey-playwright-auth", `${targetHash}.json`);
