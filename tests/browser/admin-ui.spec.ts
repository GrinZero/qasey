import { expect, test, type Page, type Route } from "@playwright/test";

interface BrowserDiagnostics {
  pageErrors: string[];
  failedRequests: string[];
  unexpectedApiRequests: string[];
}

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();

const session = {
  subjectId: "browser-test-user",
  tenantId: "tenant-browser-test",
  roles: ["platform-admin"],
  email: "qa@example.com",
  isAdmin: true,
};

const catalog = [
  {
    applicationId: "qasey",
    resourceType: "route",
    resourceId: "qasey-task",
    permission: "qasey.agent.execute",
    routePath: "/v1/qasey/tasks",
    routeMethod: "POST",
  },
];

const applications = [
  {
    id: "qasey",
    name: "Qasey QA",
    description: "Turn product requirements into traceable QA evidence.",
    category: "Quality engineering",
    capabilities: ["Risk analysis", "Test design", "Evidence review"],
    homePath: "/admin/apps/qasey",
    accent: "indigo",
  },
];

const runs = [
  {
    id: "run-awaiting-review",
    status: "awaiting_qa",
    framework: "playwright",
    platform: "web",
    changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff",
    createdAt: "2026-08-26T02:00:00.000Z",
    updatedAt: "2026-08-26T02:05:00.000Z",
    branch: "qasey/browser-gate",
    repository: { owner: "example", repository: "sample-app", baseRef: "main" },
    artifacts: [
      {
        id: "artifact-trace",
        kind: "trace",
        name: "browser-trace.zip",
        uri: "artifact://browser-trace",
        contentType: "application/zip",
      },
    ],
  },
  {
    id: "run-complete",
    status: "succeeded",
    framework: "maestro",
    platform: "app",
    changeSetId: "d825e3e4-9dc3-4ad6-829c-2f31ead90bbb",
    createdAt: "2026-08-25T02:00:00.000Z",
    updatedAt: "2026-08-25T02:10:00.000Z",
    repository: { owner: "example", repository: "mobile-sample", baseRef: "main" },
    artifacts: [],
  },
];

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

async function installAuthenticatedApiMocks(page: Page, diagnostics: BrowserDiagnostics): Promise<void> {
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/admin/api/session") {
      await json(route, session);
      return;
    }
    if (request.method() === "GET" && url.pathname === "/admin/api/catalog") {
      await json(route, catalog);
      return;
    }
    if (request.method() === "GET" && url.pathname === "/admin/api/applications") {
      await json(route, applications);
      return;
    }
    if (request.method() === "GET" && url.pathname === "/v1/case-hub/runs") {
      await json(route, { runs });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/v1/case-hub/cases") {
      await json(route, { cases: [] });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/v1/case-hub/change-sets") {
      await json(route, { changeSets: [] });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/v1/qasey/conversations") {
      await json(route, { conversations: [] });
      return;
    }
    if (url.pathname.startsWith("/admin/api/") || url.pathname.startsWith("/v1/")) {
      diagnostics.unexpectedApiRequests.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({
        status: 501,
        contentType: "application/json",
        body: JSON.stringify({ message: "Unexpected browser-test API request" }),
      });
      return;
    }
    await route.continue();
  });
}

async function installAnonymousAuthMocks(
  page: Page,
  config: { google: boolean; password: boolean; registration: boolean },
  isAuthenticated: () => boolean = () => false,
): Promise<void> {
  await page.route("**/admin/api/session", async route => {
    if (isAuthenticated()) {
      await json(route, session);
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Authentication required" }),
    });
  });
  await page.route("**/auth/organization-selection", async route => {
    await json(route, { selection: null });
  });
  await page.route("**/auth/config", async route => {
    await json(route, config);
  });
}

test.beforeEach(async ({ page }) => {
  const diagnostics: BrowserDiagnostics = {
    pageErrors: [],
    failedRequests: [],
    unexpectedApiRequests: [],
  };
  diagnosticsByPage.set(page, diagnostics);
  page.on("pageerror", error => diagnostics.pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const path = new URL(request.url()).pathname;
    const reason = request.failure()?.errorText ?? "unknown failure";
    if (path.endsWith("/events") && reason.includes("ERR_ABORTED")) return;
    diagnostics.failedRequests.push(`${request.method()} ${path}: ${reason}`);
  });
  await installAuthenticatedApiMocks(page, diagnostics);
});

test.afterEach(async ({ page }) => {
  const diagnostics = diagnosticsByPage.get(page);
  expect(diagnostics?.pageErrors, "the built Admin UI must not emit page errors").toEqual([]);
  expect(diagnostics?.failedRequests, "the built Admin UI must not lose browser requests").toEqual([]);
  expect(diagnostics?.unexpectedApiRequests, "every API request in this smoke must be intentional").toEqual([]);
});

test("password login preserves the deep link and enters the authenticated workspace", async ({ page }) => {
  let authenticated = false;
  let submittedBody: unknown;
  await installAnonymousAuthMocks(
    page,
    { google: true, password: true, registration: true },
    () => authenticated,
  );
  await page.route("**/auth/password/login", async route => {
    submittedBody = route.request().postDataJSON();
    authenticated = true;
    await json(route, { redirectTo: "/admin/apps/qasey/runs" });
  });

  await page.goto("/admin/apps/qasey/runs");
  await expect(page.getByRole("heading", { name: "登录 Agent Platform" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "密码登录" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("或使用企业账号", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "使用 Google 继续" })).toBeVisible();
  await expect(page.getByLabel("邮箱", { exact: true })).toHaveAttribute("autocomplete", "email");
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("autocomplete", "current-password");

  await page.getByLabel("邮箱", { exact: true }).fill("qa@example.com");
  await page.getByLabel("密码", { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: "使用密码登录" }).click();

  await expect(page).toHaveURL(/\/admin\/apps\/qasey\/runs$/u);
  await expect(page.getByRole("heading", { name: "追踪每一次验证" })).toBeVisible();
  expect(submittedBody).toEqual({
    email: "qa@example.com",
    password: "a-secure-password",
    redirectUri: "/admin/apps/qasey/runs",
  });
});

test("registration creates a password account without exposing disabled Google login", async ({ page }) => {
  let authenticated = false;
  let submittedBody: unknown;
  await installAnonymousAuthMocks(
    page,
    { google: false, password: true, registration: true },
    () => authenticated,
  );
  await page.route("**/auth/password/register", async route => {
    submittedBody = route.request().postDataJSON();
    authenticated = true;
    await json(route, { redirectTo: "/admin" });
  });

  await page.goto("/admin");
  await page.getByRole("tab", { name: "注册账号" }).click();
  await expect(page.getByRole("heading", { name: "创建 Qasey 账号" })).toBeVisible();
  await expect(page.getByRole("button", { name: "使用 Google 继续" })).toHaveCount(0);
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel("确认密码", { exact: true })).toHaveAttribute("autocomplete", "new-password");

  await page.getByLabel("姓名", { exact: true }).fill("QA Member");
  await page.getByLabel("邮箱", { exact: true }).fill("member@example.com");
  await page.getByLabel("密码", { exact: true }).fill("another-secure-password");
  await page.getByLabel("确认密码", { exact: true }).fill("another-secure-password");
  await page.getByRole("button", { name: "创建账号并继续" }).click();

  await expect(page).toHaveURL(/\/admin$/u);
  await expect(page.getByRole("heading", { name: "工作交给 Agent，判断留给人" })).toBeVisible();
  expect(submittedBody).toEqual({
    displayName: "QA Member",
    email: "member@example.com",
    password: "another-secure-password",
    redirectUri: "/admin",
  });
});

test("credential failures stay inline and do not masquerade as an expired session", async ({ page }) => {
  await installAnonymousAuthMocks(page, { google: false, password: true, registration: false });
  await page.route("**/auth/password/login", async route => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "邮箱或密码不正确。" }),
    });
  });

  await page.goto("/admin");
  await expect(page.getByRole("tab", { name: "注册账号" })).toHaveCount(0);
  await page.getByLabel("邮箱", { exact: true }).fill("qa@example.com");
  await page.getByLabel("密码", { exact: true }).fill("wrong-password-value");
  await page.getByRole("button", { name: "使用密码登录" }).click();

  await expect(page.getByRole("alert")).toContainText("邮箱或密码不正确。");
  await expect(page.getByText(/登录已过期/u)).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin$/u);
});

test("authenticated user can open the platform and navigate the Qasey application", async ({ page }) => {
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "工作交给 Agent，判断留给人" })).toBeVisible();
  await expect(page.getByText("无需介入", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "待处理", exact: true })).toBeVisible();
  await expect(page.getByText("tenant-browser-test", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Qasey QA" })).toBeVisible();

  await page.getByRole("button", { name: /打开工作空间/u }).click();
  await expect(page).toHaveURL(/\/admin\/apps\/qasey$/u);
  await expect(page.getByRole("heading", { name: "与 Qasey 一起完成测试任务" })).toBeVisible();
  await expect(page.getByText("Ubuntu", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /^测试运行/u }).click();
  await expect(page).toHaveURL(/\/admin\/apps\/qasey\/runs$/u);
  await expect(page.getByRole("heading", { name: "追踪每一次验证" })).toBeVisible();
  await expect(page.getByText("example/sample-app", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "待我审阅", exact: true }).click();
  await expect(page.getByRole("heading", { name: "待我审阅", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^待处理/u }).click();
  await expect(page.getByRole("heading", { name: "需要你的判断" })).toBeVisible();
  await page.getByRole("button", { name: /^活动/u }).click();
  await expect(page.getByRole("heading", { name: "所有 Agent 的工作轨迹" })).toBeVisible();
});

test("primary routes survive direct navigation and unknown paths render the 404 view", async ({ page }) => {
  const primaryRoutes = [
    ["/admin", "工作交给 Agent，判断留给人"],
    ["/admin/inbox", "需要你的判断"],
    ["/admin/activity", "所有 Agent 的工作轨迹"],
    ["/admin/apps/qasey", "与 Qasey 一起完成测试任务"],
    ["/admin/apps/qasey/runs", "追踪每一次验证"],
    ["/admin/apps/qasey/cases", "Case Hub"],
    ["/admin/apps/qasey/reviews", "待我审阅"],
  ] as const;

  for (const [path, heading] of primaryRoutes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }

  await page.goto("/admin/does-not-exist");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(page.getByText("找不到这个页面", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回平台首页" }).click();
  await expect(page).toHaveURL(/\/admin$/u);

  await page.goto("/admin/apps/qasey/workspace");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
});

test("Qasey streams a multi-turn conversation and restores it from the deep link", async ({ page }) => {
  const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const turnId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const linkedRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const occurredAt = "2026-09-04T04:00:00.000Z";
  const conversation = { id: conversationId, title: "验证预约改期流程", createdAt: occurredAt, updatedAt: occurredAt };
  const clientMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const metadata = { conversationId, turnId, createdAt: occurredAt, latestSequence: 7, linkedRunId };
  const messages = [
    { id: clientMessageId, role: "user", metadata, parts: [{ type: "text", text: "验证预约改期流程" }] },
    { id: turnId, role: "assistant", metadata, parts: [
      { type: "data-progress", id: `${turnId}:progress:2`, data: { sequence: 2, title: "正在分析需求", detail: "结合当前会话整理目标。", status: "working" } },
      { type: "dynamic-tool", toolCallId: "github-call-1", toolName: "github_get_pull_request_diff", title: "读取 GitHub", state: "output-available", input: { summary: "正在查看 example/sample-app #42 的代码改动…" }, output: { summary: "已读取 PR #42，发现 3 个文件变更…" } },
      { type: "dynamic-tool", toolCallId: "github-call-2", toolName: "github_get_pull_request_diff", title: "读取 GitHub", state: "output-available", input: { summary: "正在补充读取 PR #42 的文件列表…" }, output: { summary: "已补充读取 PR #42 的文件列表。" } },
      { type: "data-run", id: `${turnId}:run`, data: { runId: linkedRunId } },
      { type: "text", text: "已找到关键风险。测试运行已启动。", state: "done" },
      { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 5 } },
    ] },
  ];
  const streamParts = [
    { type: "start", messageId: turnId, messageMetadata: { ...metadata, latestSequence: 0, linkedRunId: undefined } },
    { type: "data-progress", id: `${turnId}:progress:2`, data: { sequence: 2, title: "正在分析需求", detail: "结合当前会话整理目标。", status: "working" } },
    { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 2 } },
    { type: "tool-input-available", toolCallId: "github-call-1", toolName: "github_get_pull_request_diff", title: "读取 GitHub", input: { summary: "正在查看 example/sample-app #42 的代码改动…" }, dynamic: true },
    { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 3 } },
    { type: "tool-output-available", toolCallId: "github-call-1", output: { summary: "已读取 PR #42，发现 3 个文件变更…" }, dynamic: true },
    { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 4 } },
    { type: "text-start", id: `${turnId}:text:0` },
    { type: "text-delta", id: `${turnId}:text:0`, delta: "已找到关键风险。测试运行已启动。" },
    { type: "data-run", id: `${turnId}:run`, data: { runId: linkedRunId } },
    { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 7 } },
    { type: "message-metadata", messageMetadata: metadata },
    { type: "text-end", id: `${turnId}:text:0` },
    { type: "finish", finishReason: "stop", messageMetadata: metadata },
  ];
  const linkedRun = { ...runs[0], id: linkedRunId };
  let sent = false;

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/v1/qasey/conversations") {
      await json(route, { conversations: sent ? [conversation] : [] });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/v1/qasey/conversations") {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ conversation: { ...conversation, title: "新 QA 任务" } }) });
      return;
    }
    if (request.method() === "GET" && url.pathname === `/v1/qasey/conversations/${conversationId}`) {
      await json(route, { conversation, messages: sent ? messages : [] });
      return;
    }
    if (request.method() === "POST" && url.pathname === `/v1/qasey/conversations/${conversationId}/messages`) {
      const body = request.postDataJSON() as { message: string; clientMessageId: string };
      expect(body.message).toBe("验证预约改期流程");
      expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/u);
      sent = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `${streamParts.map(part => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`,
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === `/v1/case-hub/runs/${linkedRunId}/events`) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify({ run: linkedRun })}\n\n` });
      return;
    }
    await route.fallback();
  });

  await page.goto("/admin/apps/qasey");
  await page.getByLabel("发送给 Qasey").fill("验证预约改期流程");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/apps/qasey\\?conversation=${conversationId}$`, "u"));
  await expect(page.locator("summary").getByText("正在分析需求", { exact: true })).toBeVisible();
  const toolSummary = page.locator(".conversation-tools > summary");
  await expect(toolSummary).toContainText("执行记录");
  const groupedToolSummary = page.locator(".conversation-tool-group > summary");
  await expect(groupedToolSummary).toBeHidden();
  await toolSummary.click();
  await expect(groupedToolSummary).toContainText("读取 GitHub");
  await expect(groupedToolSummary.locator("code")).toHaveText("github_get_pull_request_diff");
  await groupedToolSummary.click();
  await expect(page.getByText("已读取 PR #42，发现 3 个文件变更…", { exact: true })).toBeVisible();
  await expect(page.getByText("已补充读取 PR #42 的文件列表。", { exact: true })).toBeVisible();
  await expect(page.getByText("已找到关键风险。测试运行已启动。", { exact: true })).toBeVisible();
  await expect(page.locator(".conversation-tool-group > div code")).toHaveCount(2);
  await expect(page.getByText("example/sample-app", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制回复" })).toBeVisible();
  await expect(page.getByText("Qasey 返回了无法识别的消息格式。")).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("验证预约改期流程", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("已找到关键风险。测试运行已启动。", { exact: true })).toBeVisible();
  const restoredToolSummary = page.locator(".conversation-tools > summary");
  await expect(restoredToolSummary).toContainText("2 次");
  await expect(page.locator(".conversation-tool-group")).toHaveCount(1);
  await restoredToolSummary.click();
  await expect(page.locator(".conversation-tool-content strong em")).toHaveText("×2");
});

test("Qasey keeps long conversation history inside the workspace scroll region", async ({ page }) => {
  const conversationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const occurredAt = "2026-09-04T04:30:00.000Z";
  const conversations = Array.from({ length: 18 }, (_, index) => ({
    id: index === 0 ? conversationId : `ffffffff-ffff-4fff-8fff-${(index + 1).toString().padStart(12, "0")}`,
    title: index === 0 ? "长对话滚动验证" : `历史 QA 任务 ${index + 1}`,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }));
  const messages = Array.from({ length: 18 }, (_, index) => {
    const turnId = `dddddddd-dddd-4ddd-8ddd-${(index + 1).toString().padStart(12, "0")}`;
    const metadata = { conversationId, turnId, createdAt: occurredAt, latestSequence: 1 };
    return [
      { id: `user-${index}`, role: "user", metadata, parts: [{ type: "text", text: `第 ${index + 1} 轮测试需求` }] },
      { id: turnId, role: "assistant", metadata, parts: [{ type: "text", text: `第 ${index + 1} 轮分析已经完成，保留足够内容用于验证历史消息滚动。`, state: "done" }] },
    ];
  }).flat();

  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/v1/qasey/conversations") {
      await json(route, { conversations });
      return;
    }
    if (route.request().method() === "GET" && url.pathname === `/v1/qasey/conversations/${conversationId}`) {
      await json(route, { conversation: conversations[0], messages });
      return;
    }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/admin/apps/qasey?conversation=${conversationId}`);
  await expect(page.getByText("第 18 轮分析已经完成，保留足够内容用于验证历史消息滚动。", { exact: true })).toBeVisible();

  const messageScroll = page.locator(".qasey-conversation-scroll");
  const conversationList = page.locator(".conversation-list-items");
  const composer = page.getByLabel("发送给 Qasey").locator("..");
  const main = page.locator(".conversation-main");
  await expect(messageScroll).toBeVisible();
  await expect(conversationList).toBeVisible();

  expect(await messageScroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await conversationList.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const bounds = await Promise.all([
    composer.boundingBox(),
    main.boundingBox(),
  ]);
  expect(bounds[0]).not.toBeNull();
  expect(bounds[1]).not.toBeNull();
  expect(bounds[0]!.y + bounds[0]!.height).toBeLessThanOrEqual(bounds[1]!.y + bounds[1]!.height + 1);
  expect(bounds[1]!.y + bounds[1]!.height).toBeLessThanOrEqual(900);
});

test("Qasey resumes an active turn after the persisted cursor without duplicating text", async ({ page }) => {
  const conversationId = "11111111-aaaa-4111-8111-aaaaaaaaaaaa";
  const turnId = "22222222-bbbb-4222-8222-bbbbbbbbbbbb";
  const clientMessageId = "33333333-cccc-4333-8333-cccccccccccc";
  const occurredAt = "2026-09-04T05:00:00.000Z";
  const conversation = { id: conversationId, title: "恢复中的任务", activeTurnId: turnId, createdAt: occurredAt, updatedAt: occurredAt };
  const initialMetadata = { conversationId, turnId, createdAt: occurredAt, latestSequence: 4 };
  const initialMessages = [
    { id: clientMessageId, role: "user", metadata: initialMetadata, parts: [{ type: "text", text: "继续检查支付回调" }] },
    { id: turnId, role: "assistant", metadata: initialMetadata, parts: [
      { type: "data-progress", id: `${turnId}:progress:2`, data: { sequence: 2, title: "正在检查回调", detail: "读取已有测试上下文。", status: "working" } },
      { type: "text", text: "已经确认签名，", state: "streaming" },
      { type: "dynamic-tool", toolCallId: "case-search-resume", toolName: "case_hub_search_cases", title: "查询已有用例", state: "input-available", input: { summary: "正在读取 Case Hub 用例与审核状态…" } },
      { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 4 } },
    ] },
  ];
  let reconnectAfter = "";

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/v1/qasey/conversations") {
      await json(route, { conversations: [conversation] });
      return;
    }
    if (request.method() === "GET" && url.pathname === `/v1/qasey/conversations/${conversationId}`) {
      await json(route, { conversation, messages: initialMessages });
      return;
    }
    if (request.method() === "GET" && url.pathname === `/v1/qasey/conversations/${conversationId}/turns/${turnId}/events`) {
      reconnectAfter = url.searchParams.get("after") ?? "";
      const finalMetadata = { ...initialMetadata, latestSequence: 7 };
      const parts = [
        { type: "start", messageId: turnId, messageMetadata: initialMetadata },
        { type: "tool-input-available", toolCallId: "case-search-resume", toolName: "case_hub_search_cases", title: "查询已有用例", input: { summary: "正在读取 Case Hub 用例与审核状态…" }, dynamic: true },
        { type: "tool-output-available", toolCallId: "case-search-resume", output: { summary: "已读取 Case Hub 用例与审核状态…" }, dynamic: true },
        { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 5 } },
        { type: "text-start", id: `${turnId}:text:4` },
        { type: "text-delta", id: `${turnId}:text:4`, delta: "回放测试也通过了。" },
        { type: "data-cursor", id: `${turnId}:cursor`, data: { sequence: 7 } },
        { type: "text-end", id: `${turnId}:text:4` },
        { type: "finish", finishReason: "stop", messageMetadata: finalMetadata },
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "x-vercel-ai-ui-message-stream": "v1" },
        body: `${parts.map(part => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`,
      });
      return;
    }
    await route.fallback();
  });

  await page.goto(`/admin/apps/qasey?conversation=${conversationId}`);
  await expect(page.getByText("已经确认签名，回放测试也通过了。", { exact: true })).toBeVisible();
  const restoredExecutionSummary = page.locator(".conversation-tools > summary");
  await expect(restoredExecutionSummary).toContainText("本轮执行已完成");
  await expect(page.getByText("case_hub_search_cases", { exact: true })).toHaveCount(1);
  await restoredExecutionSummary.click();
  await expect(page.getByText("已读取 Case Hub 用例与审核状态…", { exact: true })).toBeVisible();
  expect(reconnectAfter).toBe("4");
  await expect(page.getByText("已经确认签名，", { exact: true })).toHaveCount(0);
});

test("case hub exposes only merged active versions and ignores newer failed proposals", async ({ page }) => {
  const latestVersionId = "22222222-2222-4222-8222-222222222222";
  const candidateVersionId = "11111111-1111-4111-8111-111111111111";
  const failedChangeSetId = "33333333-3333-4333-8333-333333333333";
  const readyChangeSetId = "44444444-4444-4444-8444-444444444444";
  const caseRecord = {
    id: "QASEY-1", suitePath: "Appointments / Reschedule", title: "Reschedule across time zones",
    activeVersionId: latestVersionId, proposedVersionIds: [candidateVersionId], updatedAt: "2026-09-03T01:00:00.000Z",
  };
  const changeSets = [
    { id: failedChangeSetId, status: "failed", revision: 2, caseVersionIds: [candidateVersionId], requirement: { goal: "Candidate update", requirementSummary: "A failed newer attempt." }, updatedAt: "2026-09-04T01:00:00.000Z" },
    { id: readyChangeSetId, status: "merged", revision: 5, caseVersionIds: [latestVersionId], pullRequestUrl: "https://example.test/pull/7", requirement: { goal: "Cover rescheduling", requirementSummary: "Validate rescheduling behavior." }, updatedAt: "2026-09-03T01:00:00.000Z" },
  ];
  const versions = [
    { id: latestVersionId, caseId: "QASEY-1", version: 2, suitePath: caseRecord.suitePath, title: caseRecord.title, description: "Covers staff and customer time zones.", priority: "P1", target: "web", preconditions: ["An appointment exists in another time zone"], steps: [{ action: "Move the appointment by one hour", expected: ["The customer sees the local converted time", "The staff calendar has no conflict"] }], tags: ["regression", "timezone"], automationPath: "e2e/reschedule.spec.ts", contentHash: "b".repeat(64), status: "active", createdAt: "2026-09-03T01:00:00.000Z" },
  ];

  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/v1/case-hub/cases") { await json(route, { cases: [caseRecord] }); return; }
    if (route.request().method() === "GET" && url.pathname === "/v1/case-hub/change-sets") { await json(route, { changeSets }); return; }
    if (route.request().method() === "GET" && url.pathname === "/v1/case-hub/cases/QASEY-1") { await json(route, { case: caseRecord, versions, changeSets: [changeSets[1]], results: [] }); return; }
    await route.fallback();
  });

  await page.goto("/admin/apps/qasey/cases");
  await expect(page.getByRole("columnheader", { name: "正式交付" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "待生效提案" })).toHaveCount(0);
  await expect(page.getByText("已合并", { exact: true })).toBeVisible();
  await expect(page.getByText("执行失败", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^QASEY-1 Reschedule/u }).click();

  const dialog = page.getByRole("dialog", { name: /QASEY-1/u });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("1 个版本", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Reschedule across time zones", exact: true })).toBeVisible();
  await expect(dialog.getByText("An appointment exists in another time zone", { exact: true })).toBeVisible();
  await expect(dialog.getByText("The customer sees the local converted time", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "打开 Pull Request" })).toHaveAttribute("href", "https://example.test/pull/7");

  await expect(dialog.getByRole("button", { name: /v1/u })).toHaveCount(0);
});

test("multi-organization login requires an explicit tenant-safe selection before entering", async ({ page }) => {
  let completed = false;
  let submittedBody: unknown;
  await page.route("**/admin/api/session", async route => {
    if (completed) {
      await json(route, { ...session, tenantId: "tenant-beta" });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Authentication required" }),
    });
  });
  await page.route("**/auth/organization-selection", async route => {
    if (route.request().method() === "GET") {
      await json(route, {
        selection: {
          redirectTo: "/admin",
          organizations: [
            { id: "tenant-alpha", displayName: "Alpha Workspace" },
            { id: "tenant-beta", displayName: "Beta Workspace" },
          ],
        },
      });
      return;
    }
    submittedBody = route.request().postDataJSON();
    completed = true;
    await json(route, { redirectTo: "/admin" });
  });

  await page.goto("/admin/select-organization");
  await expect(page.getByRole("heading", { name: "你要进入哪个组织？" })).toBeVisible();
  await expect(page.getByText("Alpha Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Beta Workspace", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Beta Workspace/u }).click();

  await expect(page).toHaveURL(/\/admin$/u);
  await expect(page.getByRole("heading", { name: "工作交给 Agent，判断留给人" })).toBeVisible();
  expect(submittedBody).toEqual({ organizationId: "tenant-beta" });
  expect(JSON.stringify(submittedBody)).not.toMatch(/userId|subjectId/u);
  await expect(page.getByText("tenant-beta", { exact: true })).toBeVisible();
});
