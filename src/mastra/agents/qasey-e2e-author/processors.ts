import type { Processor, ProcessOutputResultArgs, ProcessorMessageResult } from "@mastra/core/processors";
import {
  isE2EAuthorStudioRequest,
  requireE2EAuthorRuntime,
  resolveE2EAuthorRuntime,
} from "./runtime-bindings.ts";

/** Prevent a successful-looking answer from bypassing the Agent-owned validation contract. */
export class RequirePassingE2ECandidateValidation implements Processor {
  readonly id = "qasey-e2e-require-passing-candidate-validation";

  processOutputResult({ requestContext, messages, abort }: ProcessOutputResultArgs): ProcessorMessageResult {
    if (!requestContext) return messages;
    const runtime = resolveE2EAuthorRuntime(requestContext);
    if (!runtime && (isE2EAuthorStudioRequest(requestContext) || requestContext.get("qasey-conversation-agent") === "qasey-e2e-author")) return messages;
    const boundRuntime = runtime ?? requireE2EAuthorRuntime(requestContext);
    if (boundRuntime.validation.calls === 0) {
      abort("Call validate-e2e-candidate before finishing and repair every reported problem.", { retry: true });
    }
    if (boundRuntime.validation.lastResult?.passed !== true) {
      abort(`The latest validate-e2e-candidate result failed. Repair it and validate again.\n${boundRuntime.validation.lastResult?.summary ?? "No result was recorded."}`, { retry: true });
    }
    return messages;
  }
}
