import { expect, test, type Locator, type Page } from "@playwright/test";

interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FixedControlBounds {
  environment: ElementBounds;
  account: ElementBounds;
}

interface ScrollState {
  navigation: number;
  sidebar: number;
  page: number;
}

const desktopViewport = { width: 1280, height: 520 };
const mobileViewport = { width: 390, height: 520 };
const boundsTolerance = 1;

async function readBounds(locator: Locator, label: string): Promise<ElementBounds> {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} has no rendered bounds`);
  return bounds;
}

async function expectFullyInsideViewport(
  locator: Locator,
  viewport: { width: number; height: number },
  label: string,
): Promise<ElementBounds> {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const bounds = await readBounds(locator, label);
  expect(bounds.x, `${label} should not extend past the left viewport edge`).toBeGreaterThanOrEqual(-boundsTolerance);
  expect(bounds.y, `${label} should not extend past the top viewport edge`).toBeGreaterThanOrEqual(-boundsTolerance);
  expect(bounds.x + bounds.width, `${label} should not extend past the right viewport edge`).toBeLessThanOrEqual(viewport.width + boundsTolerance);
  expect(bounds.y + bounds.height, `${label} should not extend past the bottom viewport edge`).toBeLessThanOrEqual(viewport.height + boundsTolerance);
  return bounds;
}

async function expectFixedControlsInsideViewport(
  page: Page,
  viewport: { width: number; height: number },
): Promise<FixedControlBounds> {
  const environment = page.locator(".environment-card");
  const account = page.locator(".sidebar-user");
  const tenant = account.locator(":scope > div > span");
  const logout = account.getByRole("button", { name: "退出登录" });

  await expect(environment.getByText("Agent Runtime", { exact: true })).toBeVisible();
  await expect(tenant).toContainText(/\S/u);

  const environmentBounds = await expectFullyInsideViewport(environment, viewport, "Agent Runtime environment card");
  const accountBounds = await expectFullyInsideViewport(account, viewport, "account controls");
  await expectFullyInsideViewport(tenant, viewport, "tenant information");
  await expectFullyInsideViewport(logout, viewport, "logout button");

  return { environment: environmentBounds, account: accountBounds };
}

function expectBoundsUnchanged(before: ElementBounds, after: ElementBounds, label: string): void {
  expect(Math.abs(after.x - before.x), `${label} x position changed`).toBeLessThanOrEqual(boundsTolerance);
  expect(Math.abs(after.y - before.y), `${label} y position changed`).toBeLessThanOrEqual(boundsTolerance);
  expect(Math.abs(after.width - before.width), `${label} width changed`).toBeLessThanOrEqual(boundsTolerance);
  expect(Math.abs(after.height - before.height), `${label} height changed`).toBeLessThanOrEqual(boundsTolerance);
}

async function readScrollState(page: Page, sidebar: Locator, navigation: Locator): Promise<ScrollState> {
  const [navigationScrollTop, sidebarScrollTop, pageScrollTop] = await Promise.all([
    navigation.evaluate(element => element.scrollTop),
    sidebar.evaluate(element => element.scrollTop),
    page.evaluate(() => document.scrollingElement?.scrollTop ?? window.scrollY),
  ]);
  return { navigation: navigationScrollTop, sidebar: sidebarScrollTop, page: pageScrollTop };
}

async function verifyNavigationScrollModel(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  const sidebar = page.locator(".sidebar");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const lastNavigationItem = navigation.getByRole("button", { name: "Ubuntu 工作台", exact: true });

  const sidebarBounds = await expectFullyInsideViewport(sidebar, viewport, "sidebar");
  expect(Math.abs(sidebarBounds.y), "sidebar should start at the viewport top").toBeLessThanOrEqual(boundsTolerance);
  expect(Math.abs(sidebarBounds.height - viewport.height), "sidebar should retain the full viewport height").toBeLessThanOrEqual(boundsTolerance);
  await expect(navigation).toBeVisible();

  const initialMetrics = await navigation.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(initialMetrics.scrollHeight, "main navigation should overflow at the regression viewport").toBeGreaterThan(initialMetrics.clientHeight);
  expect(initialMetrics.scrollTop, "main navigation should begin at the top").toBe(0);

  const navigationBoundsBefore = await expectFullyInsideViewport(navigation, viewport, "main navigation");
  const controlsBefore = await expectFixedControlsInsideViewport(page, viewport);
  expect(
    navigationBoundsBefore.y + navigationBoundsBefore.height,
    "main navigation should end before the fixed environment card",
  ).toBeLessThanOrEqual(controlsBefore.environment.y + boundsTolerance);
  const scrollBefore = await readScrollState(page, sidebar, navigation);
  expect(scrollBefore.sidebar, "the sidebar itself should not be scrolled").toBe(0);

  await navigation.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });

  await expect.poll(async () => navigation.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const finalMetrics = await navigation.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(
    finalMetrics.scrollTop + finalMetrics.clientHeight,
    "main navigation should reach the end of its content",
  ).toBeGreaterThanOrEqual(finalMetrics.scrollHeight - boundsTolerance);
  await expect(lastNavigationItem).toBeVisible();

  const navigationBoundsAfter = await expectFullyInsideViewport(navigation, viewport, "main navigation");
  const controlsAfter = await expectFixedControlsInsideViewport(page, viewport);
  const scrollAfter = await readScrollState(page, sidebar, navigation);
  expect(scrollAfter.navigation, "main navigation should own the vertical scrolling").toBeGreaterThan(0);
  expect(scrollAfter.sidebar, "scrolling navigation must not scroll the whole sidebar").toBe(scrollBefore.sidebar);
  expect(scrollAfter.page, "scrolling navigation must not scroll the page").toBe(scrollBefore.page);
  expectBoundsUnchanged(navigationBoundsBefore, navigationBoundsAfter, "main navigation");
  expectBoundsUnchanged(controlsBefore.environment, controlsAfter.environment, "Agent Runtime environment card");
  expectBoundsUnchanged(controlsBefore.account, controlsAfter.account, "account controls");
}

test("QASEY-2 桌面短视口下侧栏导航独立滚动且固定控件保持可见", {
  annotation: [
    { type: "qasey.case", description: "QASEY-2" },
    { type: "qasey.version", description: "976018ec87f11a8865ca482cf7d50fbc24d22eb3bd85f018361303234cdd3d71" },
  ],
}, async ({ page }) => {
  await page.setViewportSize(desktopViewport);
  await page.goto("/admin/apps/qasey");
  await expect(page).toHaveURL(/\/admin\/apps\/qasey(?:[/?#]|$)/u);

  await verifyNavigationScrollModel(page, desktopViewport);
});

test("QASEY-3 移动端短视口下侧栏抽屉导航可滚动且固定控件保持可见", {
  annotation: [
    { type: "qasey.case", description: "QASEY-3" },
    { type: "qasey.version", description: "468be721a1b3eb35b49cef8eb71e4660a056828d383fb69b7ee88fd2633b4ab8" },
  ],
}, async ({ page }) => {
  await page.setViewportSize(mobileViewport);
  await page.goto("/admin/apps/qasey");
  await expect(page).toHaveURL(/\/admin\/apps\/qasey(?:[/?#]|$)/u);

  const sidebar = page.locator(".sidebar");
  const openNavigation = page.getByRole("button", { name: "打开导航" });
  const scrim = page.locator(".sidebar-scrim");

  await expect(sidebar).toBeHidden();
  await expect(scrim).toHaveCount(0);
  await expect(openNavigation).toBeVisible();
  await openNavigation.click();

  await expect(sidebar).toBeVisible();
  await expect(scrim).toBeVisible();
  await expect.poll(async () => Math.round((await readBounds(sidebar, "sidebar drawer")).x)).toBe(0);
  await expect(sidebar.getByRole("button", { name: "关闭导航" })).toBeVisible();

  await verifyNavigationScrollModel(page, mobileViewport);

  await sidebar.getByRole("button", { name: "关闭导航" }).click();
  await expect(sidebar).toBeHidden();
  await expect(scrim).toHaveCount(0);
  await expect(openNavigation).toBeVisible();

  const accountMenu = page.getByRole("button", { name: "账户菜单" });
  await expect(accountMenu).toBeVisible();
  await accountMenu.click();
  await expect(sidebar).toBeHidden();
});
