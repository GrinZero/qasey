import "../../../src/load-env.ts";
import { spawn } from "node:child_process";
import { getCallbackUrlCandidates } from "@mastra/mcp";
import { loadConfig, loadMcpServerConfigs, McpServerNameSchema, QaseyMcpCatalog } from "../../../packages/adapters/src/index.ts";

function openBrowser(url: URL): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

const server = McpServerNameSchema.safeParse(process.argv[2]);
if (!server.success) {
  console.error("Usage: pnpm mcp:login <figma|qaExperience|lark>");
  process.exitCode = 1;
} else {
  const config = loadConfig();
  const serverConfig = loadMcpServerConfigs(config)[server.data];
  const callbackUrls = serverConfig?.auth.type === "oauth"
    ? getCallbackUrlCandidates(serverConfig.auth.redirectUrl).map(url => url.toString())
    : [];
  const catalog = new QaseyMcpCatalog(config, {
    onAuthorizationUrl: (name, url) => {
      console.info(`Authorize ${name} in your browser: ${url.toString()}`);
      openBrowser(url);
    },
  });
  try {
    await catalog.init();
    if (callbackUrls.length > 0) {
      console.info(`OAuth callback allowlist: ${callbackUrls[0]} through ${callbackUrls.at(-1)}`);
    }
    await catalog.authenticate(server.data, { applicationId: "qasey", tenantId: "local-cli", subjectId: process.env.USER ?? "operator" });
    console.info(`${server.data} OAuth authorization completed`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${server.data} OAuth authorization failed: ${message}`);
    if (callbackUrls.length > 0) {
      console.error("If the authorization server rejected dynamic client registration, allow these exact redirect URLs:");
      for (const url of callbackUrls) console.error(`  ${url}`);
      console.error("For n8n: Settings → Instance-level MCP → OAuth settings → Allowed OAuth Redirect URLs, then retry this command.");
    }
    process.exitCode = 1;
  } finally {
    await catalog.close();
  }
}
