import "./instrumentation.ts";
import { Mastra } from "@mastra/core/mastra";
import type { CustomSpanFormatter } from "@mastra/core/observability";
import { MastraEditor } from "@mastra/editor";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { MastraAuthGoogle } from "@mastra/auth-google";
import { qaseyAgent } from "./qasey-agent.ts";
import { intentRouterAgent } from "./intent-agent.ts";
import { apiRoutes } from "./routes.ts";
import { config, createMastraRuntimeStorage, studioEditorEnabled } from "./runtime.ts";
import { e2eLifecycleWorkflow } from "./e2e-workflow.ts";

const googleAuth = config.GOOGLE_CLIENT_ID ? new MastraAuthGoogle({
  clientId: config.GOOGLE_CLIENT_ID,
  ...(config.GOOGLE_CLIENT_SECRET ? { clientSecret: config.GOOGLE_CLIENT_SECRET } : {}),
  redirectUri: config.GOOGLE_REDIRECT_URI ?? `${config.QASEY_PUBLIC_BASE_URL.replace(/\/$/, "")}/api/auth/sso/callback`,
  ...(config.GOOGLE_ALLOWED_DOMAINS ? { allowedDomains: config.GOOGLE_ALLOWED_DOMAINS } : {}),
  ...(config.GOOGLE_HOSTED_DOMAIN ? { hostedDomain: config.GOOGLE_HOSTED_DOMAIN } : {}),
  session: {
    ...(config.GOOGLE_COOKIE_PASSWORD ? { cookiePassword: config.GOOGLE_COOKIE_PASSWORD } : {}),
    secureCookies: config.NODE_ENV === "production",
  },
  mapUserToResourceId: user => user.id,
}) : undefined;

const formatDatadogSpan: CustomSpanFormatter = span => {
  const requestContext = span.requestContext ? {
    requestId: span.requestContext.requestId,
    channel: span.requestContext.channel,
    intent: span.requestContext.intent,
    writeTarget: span.requestContext.writeTarget,
  } : undefined;
  return {
    ...span,
    ...(requestContext ? { requestContext } : {}),
    ...(config.QASEY_DATADOG_CAPTURE_CONTENT ? {} : { input: undefined, output: undefined }),
  };
};

const datadogBridge = config.QASEY_ENABLE_DATADOG
  ? new (await import("@mastra/datadog")).DatadogBridge({
      mlApp: config.DD_LLMOBS_ML_APP!,
      service: config.DD_SERVICE,
      env: config.DD_ENV ?? config.NODE_ENV,
      agentless: false,
      requestContextKeys: ["channel", "intent", "writeTarget"],
      customSpanFormatter: formatDatadogSpan,
    })
  : undefined;

export const mastra = new Mastra({
  agents: { qaseyAgent, intentRouterAgent },
  workflows: { e2eLifecycleWorkflow },
  storage: createMastraRuntimeStorage(),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "qasey",
        logging: { enabled: true, level: "info" },
        ...(datadogBridge ? { bridge: datadogBridge } : {}),
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
  ...(studioEditorEnabled ? { editor: new MastraEditor({ source: "db" }) } : {}),
  environment: config.NODE_ENV,
  server: {
    ...(googleAuth ? { auth: googleAuth } : {}),
    apiRoutes,
    cors: { origin: [], allowMethods: ["GET", "POST"], allowHeaders: ["content-type", "authorization", "x-qasey-webhook-token"] },
  },
  bundler: {
    externals: [
      "@duckdb/node-bindings",
      "dd-trace",
      "@datadog/native-metrics",
      "@datadog/native-appsec",
      "@datadog/native-iast-taint-tracking",
      "@datadog/pprof",
    ],
  },
});
