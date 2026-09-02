import { createInterface } from "node:readline";
import { CuaDriver } from "@trycua/cua-driver";

interface DriverRequest {
  id: number;
  tool: string;
  arguments: Record<string, unknown>;
}

const driver = CuaDriver.create(undefined);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", line => {
  void handle(line);
});

async function handle(line: string): Promise<void> {
  let request: DriverRequest | undefined;
  try {
    request = JSON.parse(line) as DriverRequest;
    const result = await driver.callTool(request.tool, JSON.stringify(request.arguments));
    write({
      id: request.id,
      result: {
        text: result.text,
        images: result.images,
        ...(result.structuredJson ? { structuredJson: result.structuredJson } : {}),
        isError: result.isError,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        degraded: result.degraded,
        rawJson: result.rawJson,
      },
    });
  } catch (error) {
    write({
      id: request?.id ?? -1,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function shutdown(): Promise<void> {
  input.close();
  await driver.shutdown().catch(() => undefined);
  process.exitCode = 0;
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
process.stdin.once("end", () => { void shutdown(); });

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
