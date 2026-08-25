import { z } from "zod";
import { CodeTaskSpecSchema, CodeTaskStateSchema } from "../../contracts/src/index.ts";

export const CodeTaskWorkerManifestSchema = z.object({
  spec: CodeTaskSpecSchema,
  context: z.string().max(256 * 1024),
  repositoryRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  taskRoot: z.string().min(1),
  statePath: z.string().min(1),
  eventsPath: z.string().min(1),
}).strict();
export type CodeTaskWorkerManifest = z.infer<typeof CodeTaskWorkerManifestSchema>;

export const PersistedCodeTaskStateSchema = CodeTaskStateSchema;
