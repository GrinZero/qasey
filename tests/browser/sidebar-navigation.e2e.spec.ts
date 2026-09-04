import { expect, test, type Locator, type Page } from "@playwright/test";

interface BrowserDiagnostics {
  pageErrors: string[];
  failedRequests: string[];
  failedResponses: string[];
  unexpectedApiRequests: string[];
}

interface ElementRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface NavMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();
const workspaceApiPaths = [
  "/admin/api/applications",
  "/admin/api/catalog",
  "/admin/api/session",
  "/v1/case-hub/change-sets",
  "/v1/case-hub/runs",
] as const;
const accessApiPaths = ["/admin/api/audit", "/admin/api/tokens"] as const;
const expectedApiRequests = new Set(
  [...workspaceApiPaths, ...accessApiPaths].map(pathname => `GET ${pathname}`),
);

function requestLabel(method: string, url: string): string {
  return `${method} ${new URL(url).pathname}`;
}

function isApiRequest(url: string): boolean {
  const pathname = new URL(url).pathname;
  return pathname.startsWith("/admin/api/") || pathname.startsWith("/auth/") || pathname.startsWith("/v1/");
}

async function elementRect(locator: Locator): Promise<ElementRect> {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
}

async function navMetrics(nav: Locator): Promise<NavMetrics> {
  return nav.evaluate(element => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
}

function expectFullyInViewport(rect: ElementRect, viewport: { width: number; height: number }): void {
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(viewport.width);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
}

function expectVerticalPositionUnchanged(before: ElementRect, after: ElementRect): void {
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.bottom - before.bottom)).toBeLessThanOrEqual(1);
}

async function documentScrollPosition(page: Page): Promise<{ windowY: number; documentY: number; mainY: number }> {
  return page.evaluate(() => ({
    windowY: window.scrollY,
    documentY: document.documentElement.scrollTop,
    mainY: document.querySelector(".main-area")?.scrollTop ?? 0,
  }));
}

async function expectSidebarControlsInViewport(page: Page, viewport: { width: number; height: number }): Promise<void> {
  const environment = page.locator(".environment-card");
  const account = page.locator(".sidebar-user");
  const logout = account.getByRole("button", { name: "退出登录" });

  await expect(environment.getByText("Agent Runtime", { exact: true })).toBeVisible();
  await expect(account).toBeVisible();
  await expect(logout).toBeVisible();
  await expect(logout).toBeEnabled();
  expectFullyInViewport(await elementRect(environment), viewport);
  expectFullyInViewport(await elementRect(account), viewport);
  expectFullyInViewport(await elementRect(logout), viewport);
}

async function expectMobileSidebarOpen(sidebar: Locator): Promise<void> {
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => Math.abs((await elementRect(sidebar)).left)).toBeLessThanOrEqual(1);
}

async function scrollNavToEnd(page: Page, nav: Locator): Promise<NavMetrics> {
  await nav.hover();
  await page.mouse.wheel(0, 4_000);

  await expect.poll(async () => (await navMetrics(nav)).scrollTop).toBeGreaterThan(0);
  await expect.poll(async () => {
    const metrics = await navMetrics(nav);
    return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  }).toBeLessThanOrEqual(1);

  return navMetrics(nav);
}

async function performAndWaitForGetResponses(
  page: Page,
  paths: readonly string[],
  action: () => Promise<unknown>,
): Promise<void> {
  const responsesPromise = Promise.all(paths.map(pathname => page.waitForResponse(response => (
    response.request().method() === "GET" && new URL(response.url()).pathname === pathname
  ))));

  await action();
  const responses = await responsesPromise;
  for (const response of responses) {
    expect(response.ok(), `${requestLabel("GET", response.url())} returned HTTP ${response.status()}`).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  const diagnostics: BrowserDiagnostics = {
    pageErrors: [],
    failedRequests: [],
    failedResponses: [],
    unexpectedApiRequests: [],
  };
  diagnosticsByPage.set(page, diagnostics);

  page.on("pageerror", error => diagnostics.pageErrors.push(error.message));
  page.on("request", request => {
    if (!isApiRequest(request.url())) return;
    const label = requestLabel(request.method(), request.url());
    if (!expectedApiRequests.has(label)) diagnostics.unexpectedApiRequests.push(label);
  });
  page.on("requestfailed", request => diagnostics.failedRequests.push(
    `${requestLabel(request.method(), request.url())}: ${request.failure()?.errorText ?? "unknown failure"}`,
  ));
  page.on("response", response => {
    if (response.status() < 400) return;
    diagnostics.failedResponses.push(`${response.status()} ${requestLabel(response.request().method(), response.url())}`);
  });
});

test.afterEach(async ({ page }) => {
  const diagnostics = diagnosticsByPage.get(page);
  expect(diagnostics?.pageErrors, "Admin UI must not emit page errors").toEqual([]);
  expect(diagnostics?.failedRequests, "Admin UI must not lose browser requests").toEqual([]);
  expect(diagnostics?.failedResponses, "Admin UI requests must not return HTTP errors").toEqual([]);
  expect(diagnostics?.unexpectedApiRequests, "every API request in this flow must be intentional").toEqual([]);
});

test(
  "QASEY-9 短桌面视口下主导航独立滚动且底部账户控件保持可用",
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
    await performAndWaitForGetResponses(
      page,
      workspaceApiPaths,
      () => page.goto("/admin/apps/qasey"),
    );

    const sidebar = page.locator(".sidebar");
    const nav = page.getByRole("navigation", { name: "主导航" });
    const environment = page.locator(".environment-card");
    const account = page.locator(".sidebar-user");
    const access = nav.getByRole("button", { name: "访问与审计", exact: true });
    const triggers = nav.getByRole("button", { name: "触发器", exact: true });

    await expect(page.getByRole("heading", { name: "把需求变成可验证的结论" })).toBeVisible();
    await expect(sidebar.getByText("Qasey", { exact: true })).toBeVisible();
    await expect(nav).toBeVisible();
    await expect(access).toBeVisible();
    await expectSidebarControlsInViewport(page, normalViewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.setViewportSize(shortViewport);
    await expectSidebarControlsInViewport(page, shortViewport);

    const initialMetrics = await navMetrics(nav);
    expect(initialMetrics.scrollTop).toBe(0);
    expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);

    const environmentBefore = await elementRect(environment);
    const accountBefore = await elementRect(account);
    const bodyScrollBefore = await documentScrollPosition(page);
    const finalMetrics = await scrollNavToEnd(page, nav);

    expect(finalMetrics.scrollTop).toBeGreaterThan(0);
    expect(finalMetrics.scrollHeight - finalMetrics.clientHeight - finalMetrics.scrollTop).toBeLessThanOrEqual(1);
    expect(await documentScrollPosition(page)).toEqual(bodyScrollBefore);

    const environmentAfter = await elementRect(environment);
    const accountAfter = await elementRect(account);
    expectVerticalPositionUnchanged(environmentBefore, environmentAfter);
    expectVerticalPositionUnchanged(accountBefore, accountAfter);
    expectFullyInViewport(environmentAfter, shortViewport);
    expectFullyInViewport(accountAfter, shortViewport);
    await expect(triggers).toBeInViewport();
    await expect(access).toBeInViewport();
    const accessAfter = await elementRect(access);
    expect(accessAfter.bottom).toBeLessThanOrEqual(environmentAfter.top);
    expect(accessAfter.bottom).toBeLessThanOrEqual(accountAfter.top);

    await performAndWaitForGetResponses(page, accessApiPaths, () => access.click());
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    await expectSidebarControlsInViewport(page, shortViewport);
  },
);

test(
  "QASEY-10 短移动视口下侧边栏抽屉导航可滚动且固定控件不被遮挡",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-10" },
      { type: "qasey.version", description: "2364eae4be452d4b329618895df85ed517763c78988eda6b29dec298964ab1dd" },
    ],
  },
  async ({ page }) => {
    const viewport = { width: 390, height: 520 };
    await page.setViewportSize(viewport);
    await performAndWaitForGetResponses(
      page,
      workspaceApiPaths,
      () => page.goto("/admin/apps/qasey"),
    );
    await expect(page.getByRole("heading", { name: "把需求变成可验证的结论" })).toBeVisible();

    const openNavigation = page.getByRole("button", { name: "打开导航" });
    const sidebar = page.locator(".sidebar");
    const closeNavigation = sidebar.getByRole("button", { name: "关闭导航" });
    const scrim = page.locator(".sidebar-scrim");
    const nav = page.getByRole("navigation", { name: "主导航" });
    const environment = page.locator(".environment-card");
    const account = page.locator(".sidebar-user");
    const access = nav.getByRole("button", { name: "访问与审计", exact: true });

    await openNavigation.click();
    await expectMobileSidebarOpen(sidebar);
    await expect(closeNavigation).toBeVisible();
    expectFullyInViewport(await elementRect(closeNavigation), viewport);
    await expect(scrim).toBeVisible();
    await expectSidebarControlsInViewport(page, viewport);

    const initialMetrics = await navMetrics(nav);
    expect(initialMetrics.scrollTop).toBe(0);
    expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);

    const environmentBefore = await elementRect(environment);
    const accountBefore = await elementRect(account);
    const bodyScrollBefore = await documentScrollPosition(page);
    const finalMetrics = await scrollNavToEnd(page, nav);

    expect(finalMetrics.scrollTop).toBeGreaterThan(0);
    expect(finalMetrics.scrollHeight - finalMetrics.clientHeight - finalMetrics.scrollTop).toBeLessThanOrEqual(1);
    expect(await documentScrollPosition(page)).toEqual(bodyScrollBefore);

    const environmentAfter = await elementRect(environment);
    const accountAfter = await elementRect(account);
    expectVerticalPositionUnchanged(environmentBefore, environmentAfter);
    expectVerticalPositionUnchanged(accountBefore, accountAfter);
    expectFullyInViewport(environmentAfter, viewport);
    expectFullyInViewport(accountAfter, viewport);
    await expect(access).toBeInViewport();
    const accessAfter = await elementRect(access);
    expect(accessAfter.bottom).toBeLessThanOrEqual(environmentAfter.top);
    expect(accessAfter.bottom).toBeLessThanOrEqual(accountAfter.top);

    await performAndWaitForGetResponses(page, accessApiPaths, () => access.click());
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(scrim).toHaveCount(0);

    await openNavigation.click();
    await expectMobileSidebarOpen(sidebar);
    await expect(scrim).toBeVisible();
    await expectSidebarControlsInViewport(page, viewport);
  },
);
