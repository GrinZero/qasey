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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
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
    if (request.method() === "GET" && url.pathname === "/v1/case-hub/review-plans") {
      await json(route, { plans: [] });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/v1/qasey/conversations") {
      await json(route, { conversations: [] });
      return;
    }
    if (/^\/v1\/qasey\/conversations\/[^/]+\/events$/.test(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" });
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
  await expect(page.getByRole("heading", { name: "E2E 证据审核", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^待处理/u }).click();
  await expect(page.getByRole("heading", { name: "需要你的判断" })).toBeVisible();
  await page.getByRole("button", { name: /^活动/u }).click();
  await expect(page.getByRole("heading", { name: "所有 Agent 的工作轨迹" })).toBeVisible();
});

test("sidebar edge control collapses the rail, remembers the choice and stays out of the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/apps/qasey");
  const sidebar = page.locator("#app-sidebar");
  const main = page.locator("main.main-area");
  const collapse = page.getByRole("button", { name: "收起侧边栏", exact: true });
  await expect(collapse).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  const sidebarBox = await sidebar.boundingBox();
  const toggleBox = await collapse.boundingBox();
  expect(sidebarBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox!.x + toggleBox!.width / 2).toBe(sidebarBox!.x + sidebarBox!.width);
  await collapse.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveCSS("width", "76px");
  await expect(main).toHaveCSS("margin-left", "76px");
  const expand = page.getByRole("button", { name: "展开侧边栏", exact: true });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "测试运行", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/apps\/qasey\/runs$/u);
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "76px");
  await expect(expand).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(expand).toBeHidden();
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(sidebar).toHaveCSS("width", "238px");
  await expect(sidebar.getByText("Agent Runtime", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭导航", exact: true }).first().click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expand.click();
  await expect(sidebar).toHaveCSS("width", "238px");
  await expect(main).toHaveCSS("margin-left", "238px");
  await page.reload();
  await expect(collapse).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "238px");
});

test("short desktop sidebar scrolls independently while account controls stay in the viewport", async ({ page }) => {
  await page.route("**/admin/api/tokens", route => route.fulfill({ json: { tokens: [], availableScopes: [] } }));
  await page.route("**/admin/api/audit", route => route.fulfill({ json: { records: [] } }));
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto("/admin/apps/qasey");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const runtime = page.getByText("Agent Runtime", { exact: true });
  const logout = page.getByRole("button", { name: "退出登录" });
  await expect(navigation).toBeVisible();
  await expect(runtime).toBeInViewport();
  await expect(logout).toBeInViewport();
  const runtimeBefore = await runtime.boundingBox();
  const logoutBefore = await logout.boundingBox();
  await expect.poll(() => navigation.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  const pageScroll = await page.evaluate(() => window.scrollY);
  await navigation.hover();
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => navigation.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => navigation.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
  expect(await runtime.boundingBox()).toEqual(runtimeBefore);
  expect(await logout.boundingBox()).toEqual(logoutBefore);
  const access = navigation.getByRole("button", { name: "访问与审计", exact: true });
  await expect(access).toBeInViewport();
  await access.click();
  await expect(page).toHaveURL(/\/admin\/access$/u);
  await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
  await expect(logout).toBeInViewport();
});

test("primary routes survive direct navigation and unknown paths render the 404 view", async ({ page }) => {
  const primaryRoutes = [
    ["/admin", "工作交给 Agent，判断留给人"],
    ["/admin/inbox", "需要你的判断"],
    ["/admin/activity", "所有 Agent 的工作轨迹"],
    ["/admin/apps/qasey", "与 Qasey 一起完成测试任务"],
    ["/admin/apps/qasey/runs", "追踪每一次验证"],
    ["/admin/apps/qasey/cases", "Case Hub"],
    ["/admin/apps/qasey/reviews", "E2E 证据审核"],
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
      const body = request.postDataJSON() as { message: string; clientMessageId: string; recipientAgentIds: string[] };
      expect(body.message).toBe("验证预约改期流程");
      expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(body.recipientAgentIds).toEqual(["qasey-main"]);
      sent = true;
      await json(route, { accepted: true, deliveryIds: [turnId] }, 202);
      return;
    }
    if (request.method() === "GET" && url.pathname === `/v1/qasey/conversations/${conversationId}/events`) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify({ revision: sent ? 1 : 0, participants: [{ agentId: "qasey-main", name: "Qasey", description: "QA", introducedBy: "system", joinedAt: metadata.createdAt }], messages: sent ? messages : [] })}\n\n` });
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

test("Qasey can collapse the task list and keeps current-session Cases in the context rail", async ({ page }) => {
  const conversationId = "12345678-1234-4234-8234-123456789012";
  const planId = "23456789-2345-4234-8234-234567890123";
  const itemId = "34567890-3456-4234-8234-345678901234";
  const occurredAt = "2026-09-04T05:30:00.000Z";
  const conversation = { id: conversationId, title: "侧栏与会话用例", createdAt: occurredAt, updatedAt: occurredAt };
  const reviewData = { planId, revision: 1, status: "reviewing", pendingCount: 1, approvedCount: 1, removedCount: 0 };
  const messages = [{
    id: "98765432-9876-4234-8234-987654321098", role: "assistant", metadata: { conversationId, turnId: "98765432-9876-4234-8234-987654321098", createdAt: occurredAt, latestSequence: 1 },
    parts: [{ type: "data-case-review", id: "review-part", data: reviewData }, { type: "text", text: "请审核文字用例。", state: "done" }],
  }];
  const plan = {
    applicationId: "qasey", tenantId: session.tenantId, id: planId, conversationId, threadId: "thread-review", subjectId: session.subjectId,
    requirement: { goal: "Improve navigation", requirementSummary: "Keep the task list usable" }, status: "reviewing", revision: 1,
    createdBy: session.subjectId, createdAt: occurredAt, updatedAt: occurredAt,
  };
  const items = [
    { applicationId: "qasey", tenantId: session.tenantId, id: itemId, planId, ordinal: 0, revision: 1, status: "pending", automationStatus: "none", content: { operation: "create", suitePath: "Admin UI / Navigation", title: "任务侧栏可以折叠", description: "", priority: "P1", preconditions: [], steps: [{ action: "收起侧栏", expected: ["聊天区域变宽"] }], testData: {}, tags: [] }, createdAt: occurredAt, updatedAt: occurredAt },
    { applicationId: "qasey", tenantId: session.tenantId, id: "45678901-4567-4234-8234-456789012345", planId, ordinal: 1, revision: 2, status: "approved", publishedCaseId: "QASEY-2", publishedCaseVersionId: "56789012-5678-4234-8234-567890123456", automationStatus: "verified", systemTags: ["e2e"], content: { operation: "create", suitePath: "Admin UI / Context", title: "会话用例常驻右栏", description: "", priority: "P2", preconditions: [], steps: [{ action: "打开会话", expected: ["右栏显示用例"] }], testData: {}, tags: [] }, createdAt: occurredAt, updatedAt: occurredAt },
  ];

  await page.route("**/*", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/v1/qasey/conversations") { await json(route, { conversations: [conversation] }); return; }
    if (request.method() === "GET" && path === `/v1/qasey/conversations/${conversationId}`) { await json(route, { conversation, messages }); return; }
    if (request.method() === "GET" && path === `/v1/case-hub/review-plans/${planId}`) { await json(route, { plan, items, editable: true }); return; }
    await route.fallback();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/admin/apps/qasey?conversation=${conversationId}`);
  const sessionCases = page.locator(".session-cases");
  await expect(sessionCases.getByRole("heading", { name: "本次文字用例" })).toBeVisible();
  await expect(sessionCases.getByText("任务侧栏可以折叠", { exact: false })).toBeVisible();
  await expect(sessionCases.getByText("QASEY-2 · 会话用例常驻右栏", { exact: true })).toBeVisible();
  await expect(sessionCases.getByText("e2e", { exact: true })).toBeVisible();

  const pendingCase = sessionCases.getByRole("button", { name: "查看用例详情：任务侧栏可以折叠" });
  await pendingCase.click();
  const detail = page.getByRole("dialog", { name: "任务侧栏可以折叠" });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: "收起侧栏", exact: true })).toBeVisible();
  await expect(detail.getByText("聊天区域变宽", { exact: true })).toBeVisible();
  await expect(detail.getByText("未自动化", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await expect(pendingCase).toBeFocused();
  await pendingCase.press("Enter");
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "关闭用例详情" }).click();
  await expect(pendingCase).toBeFocused();
  await sessionCases.getByRole("button", { name: "查看用例详情：会话用例常驻右栏" }).click();
  const approvedDetail = page.getByRole("dialog", { name: "会话用例常驻右栏" });
  await expect(approvedDetail.getByText("已批准", { exact: true })).toBeVisible();
  await expect(approvedDetail.getByText("已验证", { exact: true })).toBeVisible();
  await approvedDetail.getByRole("button", { name: "关闭用例详情" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await pendingCase.click();
  await expect(detail).toBeVisible();
  expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await detail.screenshot({ path: "output/playwright/session-case-detail.png" });
  await detail.getByRole("button", { name: "关闭用例详情" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });


  await page.getByRole("button", { name: "收起任务会话" }).click();
  await expect(page.locator(".conversation-workspace")).toHaveClass(/conversation-workspace--list-collapsed/u);
  expect(await page.evaluate(() => localStorage.getItem("qasey:conversation-list-collapsed"))).toBe("true");
  await page.reload();
  await expect(page.getByRole("button", { name: "展开任务会话" })).toBeVisible();
});

test("failed E2E evidence links acceptance steps to video and Trace, and repair submission is single-flight", async ({ page }) => {
  const changeSetId = "67890123-6789-4234-8234-678901234567";
  const versionId = "78901234-7890-4234-8234-789012345678";
  const resultId = "89012345-8901-4234-8234-890123456789";
  let changeSet = { id: changeSetId, status: "awaiting_review", revision: 2, caseVersionIds: [versionId], requirement: { goal: "Verify navigation", requirementSummary: "A failing run must be visible as failed." }, updatedAt: "2026-09-04T06:00:00.000Z" };
  const version = { id: versionId, caseId: "QASEY-9", version: 1, suitePath: "Admin UI / Navigation", title: "Sidebar remains in viewport", description: "", priority: "P1", target: "web", preconditions: [], steps: [{ action: "Open the workspace", expected: ["Workspace is visible"] }, { action: "Scroll the task list", expected: ["Sidebar remains visible"] }, { action: "Open the final task", expected: ["Task details are readable"] }], testData: {}, tags: [], contentHash: "c".repeat(64), status: "active", createdAt: "2026-09-04T06:00:00.000Z" };
  let result = { id: resultId, changeSetId, runId: "90123456-9012-4234-8234-901234567890", caseId: "QASEY-9", caseVersionId: versionId, attempt: 1, executionStatus: "failed", reviewStatus: "pending", durationMs: 12_000, artifacts: [
    { id: "video-artifact", kind: "video", name: "qasey-9/video.webm", uri: "artifact://video", contentType: "video/webm" },
    { id: "trace-artifact", kind: "trace", name: "qasey-9/trace.zip", uri: "artifact://trace", contentType: "application/zip" },
  ] };
  let reviewCalls = 0;

  await page.route("**/*", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/v1/case-hub/change-sets") { await json(route, { changeSets: [changeSet] }); return; }
    if (request.method() === "GET" && path === `/v1/case-hub/change-sets/${changeSetId}`) { await json(route, { changeSet, versions: [version], results: [result] }); return; }
    if (request.method() === "POST" && path === `/v1/case-hub/results/${resultId}/review`) {
      reviewCalls++;
      expect(request.postDataJSON()).toMatchObject({ verdict: "request_changes", feedback: "滚动后侧栏消失" });
      await new Promise(resolve => setTimeout(resolve, 50));
      result = { ...result, reviewStatus: "changes_requested" };
      changeSet = { ...changeSet, status: "revising", revision: 3 };
      await json(route, { result, changeSet }, 202); return;
    }
    if (request.method() === "GET" && path === "/v1/case-hub/trace-viewer/index.html") { await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Trace viewer</title>" }); return; }
    if (request.method() === "GET" && path.includes(`/v1/case-hub/runs/${result.runId}/artifacts/`)) { await route.fulfill({ status: 200, contentType: path.endsWith("video-artifact") ? "video/webm" : "application/zip", body: "" }); return; }
    await route.fallback();
  });

  await page.goto("/admin/apps/qasey/reviews");
  await expect(page.getByText("E2E 未完整跑通，当前证据不可批准", { exact: true })).toBeVisible();
  await expect(page.getByText("失败诊断 · 不可批准", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准这个 Case" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "要求 Agent 修复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "验收步骤 2：Scroll the task list" })).toContainText("0:04");
  await page.getByRole("button", { name: "验收步骤 2：Scroll the task list" }).click();
  await expect(page.getByRole("button", { name: "验收步骤 2：Scroll the task list" })).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "调试 Trace" }).click();
  await expect(page.getByText("当前核对 Step 02；在 Trace 的 Actions 中打开同名分组。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "播放视频" }).click();

  await page.getByRole("button", { name: "放大视频" }).click();
  const lightbox = page.locator("dialog.evidence-lightbox");
  await expect(lightbox).toBeVisible();
  await lightbox.getByRole("button", { name: "调试 Trace" }).click();
  await expect(lightbox.getByTitle("QASEY-9 Playwright Trace Viewer")).toBeVisible();
  await lightbox.getByRole("button", { name: "关闭放大查看" }).click();
  await expect(lightbox).toBeHidden();

  await page.getByLabel("问题说明 非批准结论必填").fill("滚动后侧栏消失");
  await page.getByRole("button", { name: "要求 Agent 修复" }).dblclick();
  await expect(page.getByText("已发回 Agent。修复与复验正在后台进行，新的证据生成后会自动回到这里。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "修改中" })).toBeVisible();
  expect(reviewCalls).toBe(1);
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
    if (request.method() === "GET" && url.pathname === `/v1/qasey/conversations/${conversationId}/events`) {
      reconnectAfter = url.searchParams.get("after") ?? "";
      const restoredMessages = [initialMessages[0], {
        ...initialMessages[1], metadata: { ...initialMetadata, latestSequence: 7 },
        parts: [
          { type: "text", text: "已经确认签名，回放测试也通过了。", state: "done" },
          { type: "dynamic-tool", toolCallId: "case-search-resume", toolName: "case_hub_search_cases", title: "查询已有用例", state: "output-available", input: { summary: "正在读取 Case Hub 用例与审核状态…" }, output: { summary: "已读取 Case Hub 用例与审核状态…" } },
        ],
      }];
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify({ revision: 7, participants: [{ agentId: "qasey-main", name: "Qasey", description: "QA", introducedBy: "system", joinedAt: occurredAt }], messages: restoredMessages })}\n\n` });
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
  expect(["0", "7"]).toContain(reconnectAfter);
  await expect(page.getByText("已经确认签名，", { exact: true })).toHaveCount(0);
});

test("case hub exposes approved text versions independently from E2E delivery", async ({ page }) => {
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
    if (route.request().method() === "GET" && url.pathname === "/v1/case-hub/review-plans") { await json(route, { plans: [] }); return; }
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

for (const approvalMode of ["separate", "combined"] as const) {
test(`text case review protects drafts and approves the saved revision (${approvalMode})`, async ({ page }) => {
  const planId = "55555555-5555-4555-8555-555555555555";
  const itemId = "66666666-6666-4666-8666-666666666666";
  let item = {
    id: itemId, planId, ordinal: 0, revision: 1, status: "pending", automationStatus: "none",
    content: { operation: "create", suitePath: "Appointments / Create", title: "Create an appointment", description: "Original", priority: "P1", preconditions: [], steps: [{ action: "Submit the form", expected: ["Appointment is created"] }], testData: {}, tags: ["smoke"] },
    createdAt: "2026-09-04T01:00:00.000Z", updatedAt: "2026-09-04T01:00:00.000Z",
  };
  const plan = {
    id: planId, conversationId: "77777777-7777-4777-8777-777777777777", threadId: "thread-1", subjectId: session.subjectId,
    requirement: { goal: "Appointment review", requirementSummary: "Review text first" }, status: "reviewing", revision: 1,
    createdBy: session.subjectId, createdAt: "2026-09-04T01:00:00.000Z", updatedAt: "2026-09-04T01:00:00.000Z",
  };
  const secondItem = { ...item, id: "99999999-9999-4999-8999-999999999999", ordinal: 1, content: { ...item.content, title: "Second review case" }, status: "approved", automationStatus: "verified" };
  let changeSetCreates = 0;
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/v1/case-hub/review-plans") { await json(route, { plans: [{ plan, items: [item, secondItem], editable: true }] }); return; }
    if (request.method() === "GET" && url.pathname === `/v1/case-hub/review-plans/${planId}`) { await json(route, { plan, items: [item, secondItem], editable: true }); return; }
    if (request.method() === "PATCH" && url.pathname.endsWith(`/items/${itemId}`)) {
      const body = request.postDataJSON() as { expectedRevision: number; content: typeof item.content };
      expect(body.expectedRevision).toBe(1);
      expect(body.content.preconditions).toEqual(["First condition", "Second condition"]);
      expect(body.content.tags).toEqual(["smoke", "regression"]);
      expect(body.content.testData).toEqual({ valid: true });
      item = { ...item, revision: 2, content: body.content };
      await json(route, { plan, items: [item, secondItem], editable: true }); return;
    }
    if (request.method() === "POST" && url.pathname.endsWith(`/items/${itemId}/approve`)) {
      const body = request.postDataJSON() as { expectedRevision: number };
      expect(body.expectedRevision).toBe(2);
      item = { ...item, revision: 3, status: "approved", publishedCaseId: "QASEY-1", publishedCaseVersionId: "88888888-8888-4888-8888-888888888888" } as typeof item;
      Object.assign(plan, { status: "ready", revision: 2 });
      await json(route, { plan, items: [item, secondItem], editable: true }); return;
    }
    if (request.method() === "POST" && url.pathname === "/v1/case-hub/change-sets") { changeSetCreates++; }
    await route.fallback();
  });

  await page.goto("/admin/apps/qasey/cases");
  await expect(page.getByRole("heading", { name: "用例待办" })).toBeVisible();
  await page.getByRole("button", { name: /待审 Create an appointment/u }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("Create an appointment safely");
  await expect(page.getByRole("button", { name: "全部批准", exact: true })).toBeDisabled();
  const conditions = page.getByLabel("前置条件", { exact: true });
  await conditions.fill("First condition");
  await conditions.press("End");
  await conditions.press("Enter");
  await conditions.pressSequentially("Second condition");
  await expect(conditions).toHaveValue("First condition\nSecond condition");
  await page.getByLabel("用户标签", { exact: true }).fill("smoke, regression,");
  await page.getByLabel("测试数据（JSON）", { exact: true }).fill('{"valid":');
  await expect(page.getByRole("button", { name: "保存并批准", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /已批准 Second review case/u }).click();
  await page.getByRole("button", { name: /待审 Create an appointment/u }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("Create an appointment safely");
  await expect(page.getByLabel("测试数据（JSON）", { exact: true })).toHaveValue('{"valid":');
  await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: /^测试运行/u }).click();
  await expect(page).toHaveURL(/\/cases$/u);
  await page.getByLabel("测试数据（JSON）", { exact: true }).fill('{"valid":true}');
  if (approvalMode === "combined") {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".case-review-panel")).toBeVisible();
    expect(await page.locator(".case-review-panel").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "保存并批准", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("Create an appointment safely", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "批准文字用例", exact: true }).click();
  }
  await expect(page.getByText("文字用例已审完", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成 E2E（1 条）" })).toBeEnabled();
  expect(changeSetCreates).toBe(0);
  await page.locator(".case-review-panel").screenshot({ path: `output/playwright/casehub-${approvalMode}.png` });
});
}

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

for (const selection of ["single", "batch"] as const) {
  test(`E2E ${selection} launch links to the exact persisted conversation turn and returns to Case Hub`, async ({ page }) => {
    const planId = "a1111111-1111-4111-8111-111111111111";
    const conversationId = "a2222222-2222-4222-8222-222222222222";
    const turnId = "a3333333-3333-4333-8333-333333333333";
    const createdAt = "2026-09-05T08:00:00.000Z";
    const context = { planId, cases: [
      { caseId: "QASEY-21", caseVersionId: "a4444444-4444-4444-8444-444444444444", version: 3, title: "Appointment retry" },
      ...(selection === "batch" ? [{ caseId: "QASEY-22", caseVersionId: "a5555555-5555-4555-8555-555555555555", version: 2, title: "Appointment notification" }] : []),
    ] };
    let task: { conversationId: string; turnId: string; status: string; createdAt: string; context: typeof context } | null = null;
    const plan = { id: planId, conversationId, status: "ready", requirement: { goal: "Public E2E retry" } };
    const detail = () => ({ plan, editable: true, e2eTasks: task ? [task] : [], items: context.cases.map((item, ordinal) => ({
      id: item.caseVersionId, planId, ordinal, revision: 2, status: "approved", publishedCaseId: item.caseId, publishedCaseVersionId: item.caseVersionId,
      automationStatus: task ? task.status === "running" ? "generating" : "awaiting_review" : "failed",
      content: { operation: "create", suitePath: "Appointments", title: item.title, description: "Public fixture", priority: "P1", preconditions: [], steps: [{ action: "Open appointment", expected: ["Appointment shown"] }], testData: {}, tags: [] },
    })) });
    const metadata = { conversationId, turnId, createdAt, latestSequence: 2 };
    const messages = [
      { id: "a6666666-6666-4666-8666-666666666666", role: "user", metadata, parts: [{ type: "text", text: "Please retry the approved cases" }] },
      { id: turnId, role: "assistant", metadata: { ...metadata, e2eContext: context }, parts: [{ type: "data-progress", id: "retry-progress", data: { sequence: 2, title: "正在检查测试脚本", detail: "检查上次验证失败的定位方式", status: "working" } }] },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`, role: "assistant", metadata: { ...metadata, turnId: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}` }, parts: [{ type: "text", text: `Later conversation message ${index}. ${"Public follow-up detail. ".repeat(20)}` }] })),
    ];
    let submissions = 0;
    await page.route("**/*", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/v1/case-hub/review-plans") { await json(route, { plans: [detail()] }); return; }
      if (path === `/v1/case-hub/review-plans/${planId}`) { await json(route, detail()); return; }
      if (path === `/v1/qasey/conversations/${conversationId}/actions`) {
        expect(route.request().headers().accept).toBe("application/json");
        const body = route.request().postDataJSON();
        expect(body).toMatchObject({ type: "generate_e2e", planId, caseVersionIds: context.cases.map(item => item.caseVersionId) });
        expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/u);
        submissions++;
        task = { conversationId, turnId, status: "running", createdAt, context };
        await json(route, task, 202); return;
      }
      if (path === "/v1/qasey/conversations") { await json(route, { conversations: [{ id: conversationId, title: "Public retry session", createdAt, updatedAt: createdAt }] }); return; }
      if (path === `/v1/qasey/conversations/${conversationId}`) { await json(route, { conversation: { id: conversationId, title: "Public retry session", createdAt, updatedAt: createdAt }, messages }); return; }
      await route.fallback();
    });
    await page.goto("/admin/apps/qasey/cases");
    if (selection === "single") {
      await page.getByRole("button", { name: /已批准 Appointment retry/u }).click();
      await page.getByRole("button", { name: "重新生成 E2E", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "生成 E2E（2 条）", exact: true }).click();
    }
    await expect(page).toHaveURL(/\/cases$/u);
    const workLink = page.getByRole("link", { name: "查看 Agent 工作", exact: true }).first();
    await expect(workLink).toHaveAttribute("href", `/admin/apps/qasey?conversation=${conversationId}&turn=${turnId}`);
    await expect(page.getByText("E2E 任务已启动", { exact: true }).first()).toBeVisible();
    expect(submissions).toBe(1);
    task!.status = "completed";
    await page.reload();
    await expect(workLink).toBeVisible();
    await workLink.click();
    await expect(page).toHaveURL(new RegExp(`conversation=${conversationId}&turn=${turnId}$`, "u"));
    const banner = page.getByRole("complementary", { name: "本次 E2E 任务" });
    await expect(banner).toContainText("QASEY-21 · v3");
    if (selection === "batch") await expect(banner).toContainText("QASEY-22 · v2");
    const target = page.locator(`#conversation-turn-${turnId}`);
    await expect(target).toBeFocused();
    await expect(target).toHaveClass("focused-e2e-turn");
    const bounds = await target.boundingBox();
    const scrollBounds = await page.locator(".qasey-conversation-scroll").boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(scrollBounds!.y);
    expect(bounds!.y).toBeLessThan(scrollBounds!.y + scrollBounds!.height);
    await banner.getByRole("link", { name: "返回用例", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/cases\\?plan=${planId}`, "u"));
    await expect(page.getByRole("heading", { name: "Public E2E retry", exact: true })).toBeVisible();
    if (selection === "single") await expect(page.getByRole("button", { name: /已批准 Appointment retry/u })).toHaveAttribute("aria-expanded", "true");
    expect(submissions).toBe(1);
  });
}

test("multiple named agents receive explicit mentions while E2E keeps running and replay preserves identities", async ({ page }) => {
  const conversationId = "a1111111-1111-4111-8111-111111111111";
  const turnId = "b2222222-2222-4222-8222-222222222222";
  const occurredAt = "2026-09-05T02:00:00.000Z";
  const conversation = { id: conversationId, title: "协作测试任务", createdAt: occurredAt, updatedAt: occurredAt };
  const participants = [
    { agentId: "qasey-main", name: "Qasey", description: "协调 QA 任务", introducedBy: "system", joinedAt: occurredAt },
    { agentId: "qasey-e2e-author", name: "E2E Agent", description: "编写、验证和修复", introducedBy: "qasey-main", joinedAt: occurredAt },
  ];
  const metadata = { conversationId, turnId, createdAt: occurredAt, latestSequence: 1, linkedRunId: "c3333333-3333-4333-8333-333333333333", authorAgentId: "qasey-e2e-author", recipientAgentIds: [], collaborationStatus: "completed", messageKind: "execution" };
  let messages: unknown[] = [{ id: "event-start", role: "assistant", metadata, parts: [{ type: "text", text: "正在独立验证，执行期间可以继续交流。" }] }];
  let revision = 1;
  const sent: Array<{ message: string; clientMessageId: string; recipientAgentIds: string[] }> = [];
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/v1/qasey/conversations") { await json(route, { conversations: [conversation] }); return; }
    if (path === `/v1/qasey/conversations/${conversationId}`) { await json(route, { conversation, messages, participants, revision }); return; }
    if (path === `/v1/qasey/conversations/${conversationId}/events`) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: `id: ${revision}\nevent: snapshot\ndata: ${JSON.stringify({ revision, messages, participants })}\n\n` }); return;
    }
    if (path === "/v1/case-hub/runs/c3333333-3333-4333-8333-333333333333/events") {
      const run = { ...runs[0], id: "c3333333-3333-4333-8333-333333333333", status: "clean_verifying" };
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify({ run })}\n\n` }); return;
    }
    if (method === "POST" && path === `/v1/qasey/conversations/${conversationId}/messages`) {
      const input = route.request().postDataJSON(); sent.push(input); revision++;
      messages = [...messages, { id: input.clientMessageId, role: "user", metadata: { ...metadata, recipientAgentIds: input.recipientAgentIds, messageKind: "message" }, parts: [{ type: "text", text: input.message }] },
        ...input.recipientAgentIds.map((id: string, index: number) => ({ id: `reply-${revision}-${index}`, role: "assistant", metadata: { ...metadata, authorAgentId: id, messageKind: "message", collaborationStatus: id === "qasey-main" ? "failed" : "completed" }, parts: [{ type: "text", text: id === "qasey-main" ? "协调回复失败，E2E 执行不受影响。" : "正在验证第二条断言；补充要求会在下一编写节点应用。" }] }))];
      await json(route, { accepted: true, deliveryIds: ["delivery-one", "delivery-two"] }, 202); return;
    }
    await route.fallback();
  });
  await page.goto(`/admin/apps/qasey?conversation=${conversationId}`);
  await expect(page.getByText("正在独立验证，执行期间可以继续交流。", { exact: true })).toBeVisible();
  const composer = page.getByLabel("发送给 Qasey 或 @ Agent", { exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill("@E2E");
  await expect(page.getByRole("listbox", { name: "会话 Agent" })).toBeVisible();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "移除接收者 E2E Agent" })).toBeVisible();
  await composer.fill("@Qasey"); await composer.press("Enter");
  await expect(page.getByRole("button", { name: "移除接收者 Qasey", exact: true })).toBeVisible();
  await composer.fill("目前卡在哪里？引用文档中的 @ghost 不是收件人。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]!.recipientAgentIds).toEqual(["qasey-e2e-author", "qasey-main"]);
  await expect(page.getByText("正在验证第二条断言；补充要求会在下一编写节点应用。", { exact: true })).toBeVisible();
  await expect(page.getByText("协调回复失败，E2E 执行不受影响。", { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  await page.reload();
  await expect(page.getByText("正在验证第二条断言；补充要求会在下一编写节点应用。", { exact: true })).toHaveCount(1);
  await page.locator(".agent-message-heading").getByRole("button", { name: "E2E Agent", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "移除接收者 E2E Agent" })).toBeVisible();
  await expect(page.getByLabel("关联 E2E 任务", { exact: true })).toHaveValue("c3333333-3333-4333-8333-333333333333");
});
