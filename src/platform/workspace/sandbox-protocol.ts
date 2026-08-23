import { z } from "zod";

export const SandboxSessionClaimSchema = z.object({
  sessionId: z.string().min(1).max(200),
  workspaceId: z.string().regex(/^[a-f0-9]{64}$/u),
  generation: z.number().int().positive(),
  token: z.string().min(32).max(512),
  repositoryCacheNamespace: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  githubToken: z.string().min(32).max(4096).optional(),
}).strict();

export const SandboxRepositoryCloneSchema = z.object({
  repository: z.string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .refine(value => value.split("/").every(segment => segment !== "." && segment !== ".."), "Repository path segments cannot be dot directories"),
  destination: z.string().min(1).max(1_000),
  bare: z.boolean().default(false),
  ref: z.string().regex(/^[A-Za-z0-9._/-]+$/u).optional(),
}).strict();

export const SandboxFilesystemRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("readFile"), path: z.string(), encoding: z.string().optional() }).strict(),
  z.object({ operation: z.literal("writeFile"), path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]), recursive: z.boolean().optional(), overwrite: z.boolean().optional(), expectedMtime: z.string().datetime().optional() }).strict(),
  z.object({ operation: z.literal("appendFile"), path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]) }).strict(),
  z.object({ operation: z.literal("deleteFile"), path: z.string(), recursive: z.boolean().optional(), force: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("copyFile"), source: z.string(), destination: z.string(), recursive: z.boolean().optional(), overwrite: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("moveFile"), source: z.string(), destination: z.string(), recursive: z.boolean().optional(), overwrite: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("mkdir"), path: z.string(), recursive: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("rmdir"), path: z.string(), recursive: z.boolean().optional(), force: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("readdir"), path: z.string(), recursive: z.boolean().optional(), extension: z.union([z.string(), z.array(z.string())]).optional(), maxDepth: z.number().int().nonnegative().optional() }).strict(),
  z.object({ operation: z.literal("exists"), path: z.string() }).strict(),
  z.object({ operation: z.literal("stat"), path: z.string() }).strict(),
  z.object({ operation: z.literal("realpath"), path: z.string() }).strict(),
]);

export const SandboxExecuteRequestSchema = z.object({
  command: z.string().min(1).max(32_000),
  args: z.array(z.string()).max(1_000).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().max(30 * 60_000).optional(),
  maxRetainedBytes: z.number().int().positive().max(16 * 1024 * 1024).optional(),
}).strict();

export const SandboxBrowserStartSchema = z.object({
  url: z.url().optional(),
  width: z.number().int().min(320).max(3840).default(1440),
  height: z.number().int().min(240).max(2160).default(900),
}).strict();

export const SandboxBrowserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.url() }).strict(),
  z.object({ action: z.literal("click"), x: z.number().nonnegative(), y: z.number().nonnegative(), button: z.enum(["left", "middle", "right"]).default("left") }).strict(),
  z.object({ action: z.literal("type"), text: z.string().max(100_000) }).strict(),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("reload") }).strict(),
  z.object({ action: z.literal("back") }).strict(),
  z.object({ action: z.literal("forward") }).strict(),
]);

export const SandboxDesktopStartSchema = z.object({
  application: z.enum(["none", "browser", "terminal", "editor", "files"]).default("browser"),
  url: z.url().optional(),
  recordVideo: z.boolean().default(true),
}).strict();

export const SandboxDesktopApplicationSchema = z.object({
  application: z.enum(["browser", "terminal", "editor", "files"]),
  url: z.url().optional(),
}).strict();

export const SandboxDesktopActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), x: z.number().nonnegative(), y: z.number().nonnegative(), button: z.enum(["left", "middle", "right"]).default("left"), count: z.number().int().min(1).max(3).default(1) }).strict(),
  z.object({ action: z.literal("doubleClick"), x: z.number().nonnegative(), y: z.number().nonnegative(), button: z.enum(["left", "middle", "right"]).default("left") }).strict(),
  z.object({ action: z.literal("rightClick"), x: z.number().nonnegative(), y: z.number().nonnegative() }).strict(),
  z.object({ action: z.literal("type"), text: z.string().max(100_000) }).strict(),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(100), modifiers: z.array(z.string().min(1).max(32)).max(8).optional() }).strict(),
  z.object({ action: z.literal("hotkey"), keys: z.array(z.string().min(1).max(32)).min(1).max(8) }).strict(),
  z.object({ action: z.literal("move"), x: z.number().nonnegative(), y: z.number().nonnegative() }).strict(),
  z.object({ action: z.literal("scroll"), x: z.number().nonnegative().optional(), y: z.number().nonnegative().optional(), direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(50).default(3) }).strict(),
  z.object({ action: z.literal("drag"), fromX: z.number().nonnegative(), fromY: z.number().nonnegative(), toX: z.number().nonnegative(), toY: z.number().nonnegative(), durationMs: z.number().int().min(0).max(30_000).default(500) }).strict(),
  z.object({ action: z.literal("clipboardRead") }).strict(),
  z.object({ action: z.literal("clipboardWrite"), text: z.string().max(1_000_000) }).strict(),
]);

export const sandboxDesktopTools = [
  "list_apps", "list_windows", "get_window_state", "verify_state", "bring_to_front",
  "set_window_frame", "invoke_menu", "click", "double_click", "right_click", "drag",
  "type_text", "press_key", "hotkey", "set_value", "scroll", "clipboard_read",
  "clipboard_write", "get_screen_size", "get_cursor_position", "move_cursor",
  "get_agent_cursor_state", "get_accessibility_tree", "zoom", "health_report",
] as const;

export const SandboxDesktopToolSchema = z.object({
  tool: z.enum(sandboxDesktopTools),
  arguments: z.record(z.string(), z.unknown()).default({}),
}).strict();

export interface SandboxLeaseScope {
  applicationId: string;
  tenantId: string;
  sessionId: string;
}

export interface SandboxLease extends SandboxLeaseScope {
  workspaceId: string;
  ordinal: number;
  generation: number;
  token: string;
  state: "active" | "idle";
  lastActivityAt: string;
}

export interface SandboxSessionState {
  sessionId: string;
  workspaceId: string;
  generation: number;
  lastActivityAt: string;
  browser: { running: boolean; url?: string; title?: string };
  desktop: {
    running: boolean;
    available: boolean;
    display?: string;
    width?: number;
    height?: number;
    recording?: boolean;
    ownerSessionId?: string;
    applications?: string[];
  };
}
