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
    if (request.method() === "GET" && url.pathname === "/v1/runs") {
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
  page.on("requestfailed", request => diagnostics.failedRequests.push(
    `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "unknown failure"}`,
  ));
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
  await expect(page.getByText("tenant-browser-test", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Qasey QA" })).toBeVisible();

  await page.getByRole("button", { name: /打开工作空间/u }).click();
  await expect(page).toHaveURL(/\/admin\/apps\/qasey$/u);
  await expect(page.getByRole("heading", { name: "把需求变成可验证的结论" })).toBeVisible();

  await page.getByRole("button", { name: /^测试运行/u }).click();
  await expect(page).toHaveURL(/\/admin\/apps\/qasey\/runs$/u);
  await expect(page.getByRole("heading", { name: "追踪每一次验证" })).toBeVisible();
  await expect(page.getByText("example/sample-app", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^待我审阅/u }).click();
  await expect(page.getByRole("heading", { name: "测试用例与变更审阅" })).toBeVisible();
  await page.getByRole("button", { name: /^待处理/u }).click();
  await expect(page.getByRole("heading", { name: "需要你的判断" })).toBeVisible();
  await page.getByRole("button", { name: /^活动/u }).click();
  await expect(page.getByRole("heading", { name: "所有 Agent 的工作轨迹" })).toBeVisible();
});

test("sidebar navigation scrolls without pushing account controls out of a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto("/admin/apps/qasey");

  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(page.getByText("tenant-browser-test", { exact: true })).toBeVisible();

  const dimensions = await navigation.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await navigation.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(() => navigation.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "访问与审计", exact: true })).toBeVisible();
});

test("primary routes survive direct navigation and unknown paths render the 404 view", async ({ page }) => {
  const primaryRoutes = [
    ["/admin", "工作交给 Agent，判断留给人"],
    ["/admin/inbox", "需要你的判断"],
    ["/admin/activity", "所有 Agent 的工作轨迹"],
    ["/admin/apps/qasey", "把需求变成可验证的结论"],
    ["/admin/apps/qasey/runs", "追踪每一次验证"],
    ["/admin/apps/qasey/cases", "测试用例与变更审阅"],
    ["/admin/apps/qasey/reviews", "测试用例与变更审阅"],
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
