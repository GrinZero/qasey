import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import { z } from "zod";

export const PlatformChannelSchema = z.enum(["api", "web", "slack", "jira", "worker"]);
const NativeChannelContextSchema = z.object({
  platform: z.string().min(1),
  userId: z.string().min(1),
}).catchall(z.unknown());

export const PlatformIdentitySchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  roles: z.array(z.string().min(1)),
  service: z.boolean().default(false),
});

export const PlatformRequestContextSchema = z.object({
  requestId: z.string().min(1),
  applicationId: z.string().min(1),
  // Mastra Channels replaces this key with its native channel context before
  // Agent validation. Native API/worker callers retain the enum form.
  channel: z.union([PlatformChannelSchema, NativeChannelContextSchema]),
  ingressSource: z.string().min(1),
  identity: PlatformIdentitySchema,
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  executionId: z.string().min(1).optional(),
  [MASTRA_RESOURCE_ID_KEY]: z.string().min(1),
  [MASTRA_THREAD_ID_KEY]: z.string().min(1),
}).catchall(z.unknown());

export type PlatformRequestContextValues = z.infer<typeof PlatformRequestContextSchema>;

export { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY };
