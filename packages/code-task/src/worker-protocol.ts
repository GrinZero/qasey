import { z } from "zod";
import { dirname, sep } from "node:path";
import { CodeTaskSpecSchema, CodeTaskStateSchema } from "../../contracts/src/index.ts";

export const CodeTaskWorkerManifestSchema = z.object({
  spec: CodeTaskSpecSchema,
  context: z.string().max(256 * 1024),
  workspaceRoot: z.string().min(1),
  taskRoot: z.string().min(1),
  controlRoot: z.string().min(1),
  artifactRoot: z.string().min(1),
  artifactUriPrefix: z.string().regex(/^sandbox:\/\/code-task-artifacts\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u),
  checkRoot: z.string().min(1),
  isolation: z.enum(["bwrap", "none"]),
  checkRuntimeReadOnlyPaths: z.array(z.string().min(1)).max(32),
  statePath: z.string().min(1),
  eventsPath: z.string().min(1),
  inputPatchPath: z.string().min(1).optional(),
  repositoryMounts: z.array(z.object({
    root: z.string().min(1),
    mode: z.enum(["read", "write"]),
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  }).strict()).min(1).max(8),
}).strict();
export type CodeTaskWorkerManifest = z.infer<typeof CodeTaskWorkerManifestSchema>;

export const CodeTaskWorkerCredentialsSchema = z.object({
  openaiApiKey: z.string().min(1).max(32 * 1024).optional(),
  openaiBaseUrl: z.string().min(1).max(8 * 1024).optional(),
}).strict();
export type CodeTaskWorkerCredentials = z.infer<typeof CodeTaskWorkerCredentialsSchema>;

export function buildFreshDeviceBwrapArgs(input: {
  isolation: "bwrap" | "none";
  workspacePath: string;
  allowNetwork: boolean;
  readOnly?: boolean;
  readOnlyPaths?: readonly string[];
  readWritePaths?: readonly string[];
}): string[] | undefined {
  if (input.isolation !== "bwrap") return undefined;
  const systemPaths = [
    "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc/alternatives", "/etc/ssl",
    "/etc/ca-certificates", "/etc/resolv.conf", "/etc/hosts", "/etc/passwd", "/etc/group",
    "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/localtime",
  ];
  const args = ["--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  if (!input.allowNetwork) args.push("--unshare-net");
  args.push(
    "--proc", "/proc",
    // These are fresh filesystems inside the namespace, not host/container
    // device binds. child_process and Chromium get the standard character
    // devices plus private shared memory without seeing outer devices.
    "--dev", "/dev",
    "--tmpfs", "/dev/shm",
    "--tmpfs", "/tmp",
  );
  for (const path of systemPaths) args.push("--ro-bind-try", path, path);
  for (const path of input.readOnlyPaths ?? []) args.push("--ro-bind", path, path);
  const nodeDirectory = dirname(process.execPath);
  if (!systemPaths.some(path => nodeDirectory === path || nodeDirectory.startsWith(`${path}${sep}`))) {
    args.push("--ro-bind", nodeDirectory, nodeDirectory);
  }
  args.push("--ro-bind-try", "/opt", "/opt", "--ro-bind-try", "/snap", "/snap");
  args.push(input.readOnly ? "--ro-bind" : "--bind", input.workspacePath, input.workspacePath);
  for (const path of input.readWritePaths ?? []) args.push("--bind", path, path);
  args.push("--chdir", input.workspacePath, "--die-with-parent");
  return args;
}

export const PersistedCodeTaskStateSchema = CodeTaskStateSchema;
