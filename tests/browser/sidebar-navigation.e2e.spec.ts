import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

interface BrowserDiagnostics {
  pageErrors: string[];
  failedRequests: string[];
  unexpectedApiRequests: string[];
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const viewport = { width: 1280, height: 520 };
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
    const requestKey = `${request.method()} ${url.pathname}`;

    if (requestKey === "GET /admin/api/session") {
      await json(route, session);
      return;
    }
    if (requestKey === "GET /admin/api/catalog") {
      await json(route, catalog);
      return;
    }
    if (requestKey === "GET /admin/api/applications") {
      await json(route, applications);
      return;
    }
    if (requestKey === "GET /v1/case-hub/runs") {
      await json(route, { runs: [] });
      return;
    }
    if (requestKey === "GET /v1/case-hub/cases") {
      await json(route, { cases: [] });
      return;
    }
    if (requestKey === "GET /v1/case-hub/change-sets") {
      await json(route, { changeSets: [] });
      return;
    }
    if (requestKey === "GET /admin/api/audit") {
      await json(route, { records: [] });
      return;
    }
    if (requestKey === "GET /admin/api/tokens") {
      await json(route, { tokens: [], availableScopes: [] });
      return;
    }
    if (url.pathname.startsWith("/admin/api/") || url.pathname.startsWith("/v1/")) {
      diagnostics.unexpectedApiRequests.push(requestKey);
      await route.fulfill({
        status: 501,
        contentType: "application/json",
        body: JSON.stringify({ message: "Unexpected sidebar regression API request" }),
      });
      return;
    }
    await route.continue();
  });
}

async function visibleBox(locator: Locator, label: string): Promise<Box> {
  await expect(locator, `${label} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} does not have a layout box`);
  return box;
}

function expectInsideViewport(box: Box, label: string): void {
  expect(box.x, `${label} must not be clipped by the left viewport edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} must not be clipped by the top viewport edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} must not be clipped by the right viewport edge`).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, `${label} must not be clipped by the bottom viewport edge`).toBeLessThanOrEqual(viewport.height);
}

async function fixedControlBoxes(controls: {
  runtime: Locator;
  account: Locator;
  logout: Locator;
}): Promise<Record<"runtime" | "account" | "logout", Box>> {
  const [runtime, account, logout] = await Promise.all([
    visibleBox(controls.runtime, "Agent Runtime control"),
    visibleBox(controls.account, "tenant account control"),
    visibleBox(controls.logout, "logout control"),
  ]);
  return { runtime, account, logout };
}

function expectControlsInsideViewport(boxes: Record<"runtime" | "account" | "logout", Box>): void {
  expectInsideViewport(boxes.runtime, "Agent Runtime control");
  expectInsideViewport(boxes.account, "tenant account control");
  expectInsideViewport(boxes.logout, "logout control");
}

test.use({ viewport });

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
  expect(diagnostics?.pageErrors, "the Admin UI must not emit page errors").toEqual([]);
  expect(diagnostics?.failedRequests, "the Admin UI must not lose browser requests").toEqual([]);
  expect(diagnostics?.unexpectedApiRequests, "every API request in this regression must be intentional").toEqual([]);
});

test(
  "QASEY-7 short desktop sidebar navigation scrolls independently while fixed controls remain usable",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-7" },
      { type: "qasey.version", description: "63960e5ebcb529cb07712a38e11812126ce2d2a3526ecfd0e4391d61ef8b8615" },
    ],
  },
  async ({ page }) => {
    await page.goto("/admin/apps/qasey");
    await expect(page.getByRole("heading", { name: "把需求变成可验证的结论" })).toBeVisible();

    const sidebar = page.getByRole("complementary");
    const main = page.getByRole("main");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    const accessButton = navigation.getByRole("button", { name: "访问与审计", exact: true });
    const logoutButton = sidebar.getByRole("button", { name: "退出登录" });
    const fixedControls = {
      runtime: sidebar.getByText("Agent Runtime", { exact: true }).locator("..").locator(".."),
      account: sidebar.getByText("tenant-browser-test", { exact: true }).locator("..").locator(".."),
      logout: logoutButton,
    };

    await expect(sidebar.getByText("1 个 Application 在线", { exact: true })).toBeVisible();
    await expect(logoutButton).toBeEnabled();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const controlsBefore = await fixedControlBoxes(fixedControls);
    expectControlsInsideViewport(controlsBefore);
    const sidebarBefore = await visibleBox(sidebar, "sidebar");
    const mainBefore = await visibleBox(main, "main content");
    const navigationBefore = await navigation.evaluate(element => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));

    expect(navigationBefore.scrollTop, "navigation must start at the top").toBe(0);
    expect(
      navigationBefore.scrollHeight,
      "short viewport must produce real navigation overflow",
    ).toBeGreaterThan(navigationBefore.clientHeight);

    await navigation.hover();
    await page.mouse.wheel(0, navigationBefore.scrollHeight);
    await expect.poll(
      () => navigation.evaluate(element =>
        Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)),
      { message: "wheel input over the navigation must reach its scroll end" },
    ).toBeLessThanOrEqual(1);

    const navigationAfter = await navigation.evaluate(element => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(navigationAfter.scrollTop, "navigation must move away from its initial position").toBeGreaterThan(0);
    expect(
      Math.abs(navigationAfter.scrollHeight - navigationAfter.clientHeight - navigationAfter.scrollTop),
      "navigation must reach its scroll end",
    ).toBeLessThanOrEqual(1);
    await expect(accessButton).toBeVisible();
    expect(await page.evaluate(() => window.scrollY), "wheel input must not scroll the page").toBe(0);
    expect(await visibleBox(sidebar, "sidebar after navigation scroll")).toEqual(sidebarBefore);
    expect(await visibleBox(main, "main content after navigation scroll")).toEqual(mainBefore);

    const controlsAfterScroll = await fixedControlBoxes(fixedControls);
    expectControlsInsideViewport(controlsAfterScroll);
    expect(controlsAfterScroll, "fixed controls must not move or resize when navigation scrolls").toEqual(controlsBefore);
    await expect(logoutButton).toBeEnabled();

    const accessDataResponses = Promise.all([
      page.waitForResponse(response =>
        response.request().method() === "GET" && new URL(response.url()).pathname === "/admin/api/audit"),
      page.waitForResponse(response =>
        response.request().method() === "GET" && new URL(response.url()).pathname === "/admin/api/tokens"),
    ]);
    await accessButton.click();
    const [auditResponse, tokensResponse] = await accessDataResponses;
    expect(auditResponse.ok(), "audit data request must succeed").toBe(true);
    expect(tokensResponse.ok(), "API token request must succeed").toBe(true);
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    await expect(page.getByText("还没有 API Token", { exact: true })).toBeVisible();
    await expect(page.getByText("暂无审计记录", { exact: true })).toBeVisible();

    const controlsAfterNavigation = await fixedControlBoxes(fixedControls);
    expectControlsInsideViewport(controlsAfterNavigation);
    expect(controlsAfterNavigation, "fixed controls must not move or resize after route navigation").toEqual(controlsBefore);
    await expect(logoutButton).toBeEnabled();
    expect(await page.evaluate(() => window.scrollY), "route navigation must leave the window at the top").toBe(0);
  },
);
