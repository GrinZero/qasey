export const DEFAULT_SLACK_DEV_RUNTIME_COMMAND = "/qasey-local";

export function normalizeSlackDevRuntimeCommand(
  value: string | undefined,
  fallback = DEFAULT_SLACK_DEV_RUNTIME_COMMAND,
): string {
  const command = value?.trim() || fallback;
  if (command.length > 32 || !/^\/\S+$/u.test(command)) {
    throw new Error("Slash Command 必须以 / 开头、不能包含空格，并且最多 32 个字符。");
  }
  return command;
}
