import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

interface BrowserDiagnostics {
  pageErrors: string[];
  failedRequests: string[];
  unexpectedApiRequests: string[];
}

interface Viewport {
  width: number;
  height: number;
}

interface ScrollPosition {
  windowY: number;
  documentTop: number;
  mainTop: number;
}

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();

const session = {
  subjectId: "browser-test-user",
  tenantId: "tenant-browser-test",
  roles: ["platform-admin"],
  email: "qa@example.com",
  isAdmin: true,
};

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
    const responses: Record<string, unknown> = {
      "GET /admin/api/session": session,
      "GET /admin/api/catalog": [],
      "GET /admin/api/applications": applications,
      "GET /v1/case-hub/runs": { runs: [] },
      "GET /v1/case-hub/change-sets": { changeSets: [] },
      "GET /admin/api/audit": { records: [] },
      "GET /admin/api/tokens": { tokens: [], availableScopes: [] },
    };

    if (requestKey in responses) {
      await json(route, responses[requestKey]);
      return;
    }
    if (url.pathname.startsWith("/admin/api/") || url.pathname.startsWith("/v1/")) {
      diagnostics.unexpectedApiRequests.push(requestKey);
      await route.fulfill({
        status: 501,
        contentType: "application/json",
        body: JSON.stringify({ message: "Unexpected sidebar E2E API request" }),
      });
      return;
    }
    await route.continue();
  });
}

async function boundingBox(locator: Locator, description: string) {
  const box = await locator.boundingBox();
  expect(box, `${description} must have a rendered bounding box`).not.toBeNull();
  if (!box) throw new Error(`${description} does not have a rendered bounding box`);
  return box;
}

async function expectFullyInViewport(locator: Locator, viewport: Viewport, description: string) {
  await expect(locator, `${description} must be visible`).toBeVisible();
  const box = await boundingBox(locator, description);
  expect(box.x, `${description} must not extend past the left viewport edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${description} must not extend past the top viewport edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${description} must not extend past the right viewport edge`).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, `${description} must not extend past the bottom viewport edge`).toBeLessThanOrEqual(viewport.height);
  return box;
}

async function scrollPosition(page: Page): Promise<ScrollPosition> {
  return page.evaluate(() => ({
    windowY: window.scrollY,
    documentTop: document.scrollingElement?.scrollTop ?? 0,
    mainTop: document.querySelector<HTMLElement>(".main-area")?.scrollTop ?? 0,
  }));
}

async function scrollNavigationToEnd(page: Page, navigation: Locator): Promise<void> {
  const scrollHeight = await navigation.evaluate(element => element.scrollHeight);
  await navigation.hover();
  await page.mouse.wheel(0, scrollHeight * 2);
  await expect.poll(
    () => navigation.evaluate(element => element.scrollTop),
    { message: "main navigation must consume wheel input" },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => navigation.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1),
    { message: "main navigation must reach its lower scroll boundary" },
  ).toBe(true);
}

async function expectOverflowingNavigation(navigation: Locator): Promise<void> {
  const metrics = await navigation.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(metrics.scrollHeight, "main navigation content must overflow its available height").toBeGreaterThan(metrics.clientHeight);
}

async function expectDrawerOpen(sidebar: Locator): Promise<void> {
  await expect(sidebar).toHaveClass(/\bsidebar--open\b/u);
  await expect(sidebar).toBeVisible();
  await expect.poll(
    () => sidebar.evaluate(element => getComputedStyle(element).transform),
    { message: "mobile sidebar opening transition must finish" },
  ).toBe("matrix(1, 0, 0, 1, 0, 0)");
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
  expect(diagnostics?.pageErrors, "the Admin UI must not emit page errors").toEqual([]);
  expect(diagnostics?.failedRequests, "the Admin UI must not lose browser requests").toEqual([]);
  expect(diagnostics?.unexpectedApiRequests, "every API request in this E2E test must be intentional").toEqual([]);
});

test(
  "QASEY-9 short desktop sidebar scrolls independently while fixed controls remain usable",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-9" },
      { type: "qasey.version", description: "f79bca737a62a037537a55769d7d449b3de7692756988e4b267b8d5d0d9bac52" },
    ],
  },
  async ({ page }) => {
    const normalViewport = { width: 1280, height: 900 };
    const shortViewport = { width: 1280, height: 520 };
    await page.setViewportSize(normalViewport);
    await page.goto("/admin/apps/qasey");

    const sidebar = page.locator(".sidebar");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    const environment = sidebar.locator(".environment-card");
    const account = sidebar.locator(".sidebar-user");
    const logout = sidebar.getByRole("button", { name: "退出登录" });
    const access = navigation.getByRole("button", { name: "访问与审计" });

    await expect(page.getByRole("heading", { name: "把需求变成可验证的结论" })).toBeVisible();
    await expect(sidebar.getByText("Qasey", { exact: true })).toBeVisible();
    await expect(navigation).toBeVisible();
    await expect(environment.getByText("Agent Runtime", { exact: true })).toBeVisible();
    await expect(account.getByText("tenant-browser-test", { exact: true })).toBeVisible();
    await expect(logout).toBeVisible();
    const horizontalExtent = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(horizontalExtent.scrollWidth, "normal desktop layout must not overflow horizontally").toBe(horizontalExtent.clientWidth);

    await page.setViewportSize(shortViewport);
    await expectOverflowingNavigation(navigation);
    const environmentBefore = await expectFullyInViewport(environment, shortViewport, "Agent Runtime environment section");
    const accountBefore = await expectFullyInViewport(account, shortViewport, "tenant account section");
    await expectFullyInViewport(logout, shortViewport, "logout button");
    const pageScrollBefore = await scrollPosition(page);

    await scrollNavigationToEnd(page, navigation);
    await page.mouse.wheel(0, 800);
    expect(await scrollPosition(page), "navigation scrolling must not move the page body").toEqual(pageScrollBefore);
    expect(await boundingBox(environment, "Agent Runtime environment section"), "environment section must stay fixed while navigation scrolls").toEqual(environmentBefore);
    expect(await boundingBox(account, "tenant account section"), "account section must stay fixed while navigation scrolls").toEqual(accountBefore);
    await expect(navigation.getByRole("button", { name: "触发器" })).toBeVisible();
    const accessBox = await expectFullyInViewport(access, shortViewport, "access and audit navigation entry");
    expect(accessBox.y + accessBox.height, "access entry must not be obscured by the account section").toBeLessThanOrEqual(accountBefore.y);

    await access.click();
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    await expectFullyInViewport(environment, shortViewport, "Agent Runtime environment section after navigation");
    await expectFullyInViewport(account, shortViewport, "tenant account section after navigation");
    await expectFullyInViewport(logout, shortViewport, "logout button after navigation");
  },
);

test(
  "QASEY-10 short mobile drawer scrolls independently and closes after navigation",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-10" },
      { type: "qasey.version", description: "2364eae4be452d4b329618895df85ed517763c78988eda6b29dec298964ab1dd" },
    ],
  },
  async ({ page }) => {
    const viewport = { width: 390, height: 520 };
    await page.setViewportSize(viewport);
    await page.goto("/admin/apps/qasey");
    await expect(page.getByRole("heading", { name: "把需求变成可验证的结论" })).toBeVisible();

    const sidebar = page.locator(".sidebar");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    const environment = sidebar.locator(".environment-card");
    const account = sidebar.locator(".sidebar-user");
    const logout = sidebar.getByRole("button", { name: "退出登录" });
    const closeNavigation = sidebar.getByRole("button", { name: "关闭导航" });
    const access = navigation.getByRole("button", { name: "访问与审计" });
    const scrim = page.locator(".sidebar-scrim");

    await page.getByRole("button", { name: "打开导航" }).click();
    await expectDrawerOpen(sidebar);
    await expect(scrim).toBeVisible();
    await expectFullyInViewport(closeNavigation, viewport, "close navigation button");
    await expectOverflowingNavigation(navigation);
    const environmentBefore = await expectFullyInViewport(environment, viewport, "mobile Agent Runtime environment section");
    const accountBefore = await expectFullyInViewport(account, viewport, "mobile tenant account section");
    await expect(account.getByText("tenant-browser-test", { exact: true })).toBeVisible();
    await expectFullyInViewport(logout, viewport, "mobile logout button");
    const pageScrollBefore = await scrollPosition(page);

    await scrollNavigationToEnd(page, navigation);
    await page.mouse.wheel(0, 800);
    expect(await scrollPosition(page), "drawer navigation scrolling must not move the page body").toEqual(pageScrollBefore);
    expect(await boundingBox(environment, "mobile Agent Runtime environment section"), "mobile environment section must stay fixed while navigation scrolls").toEqual(environmentBefore);
    expect(await boundingBox(account, "mobile tenant account section"), "mobile account section must stay fixed while navigation scrolls").toEqual(accountBefore);
    const accessBox = await expectFullyInViewport(access, viewport, "mobile access and audit navigation entry");
    expect(accessBox.y + accessBox.height, "mobile access entry must not be obscured by the account section").toBeLessThanOrEqual(accountBefore.y);

    await access.click();
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    await expect(sidebar).not.toHaveClass(/\bsidebar--open\b/u);
    await expect(sidebar).toBeHidden();
    await expect(scrim).toHaveCount(0);

    await page.getByRole("button", { name: "打开导航" }).click();
    await expectDrawerOpen(sidebar);
    await expectFullyInViewport(environment, viewport, "reopened mobile Agent Runtime environment section");
    await expect(account.getByText("tenant-browser-test", { exact: true })).toBeVisible();
    await expectFullyInViewport(account, viewport, "reopened mobile tenant account section");
    await expectFullyInViewport(logout, viewport, "reopened mobile logout button");
    await expect(logout).toBeEnabled();
  },
);
