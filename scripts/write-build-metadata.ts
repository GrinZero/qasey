import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildMetadataPath,
  resolveBuildMetadata,
  resolveBuildMetadataDirectory,
} from "../src/platform/e2e/build-metadata.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const metadata = resolveBuildMetadata(projectRoot);
mkdirSync(resolveBuildMetadataDirectory(projectRoot), { recursive: true, mode: 0o750 });
writeFileSync(buildMetadataPath(projectRoot), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o640 });
