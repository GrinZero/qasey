import { expect, test, type Locator, type Page } from "@playwright/test";

const desktopViewport = { width: 1280, height: 520 } as const;
const mobileViewport = { width: 390, height: 520 } as const;

interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutSnapshot {
  sidebar: ElementBounds;
  environmentCard: ElementBounds;
  accountArea: ElementBounds;
  pageScrollY: number;
  sidebarScrollTop: number;
}

interface NavigationMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

function requiredTenantId(): string {
  const tenantId = process.env.E2E_TEST_TENANT_ID;
  if (!tenantId?.trim()) throw new Error("Missing required E2E environment variable E2E_TEST_TENANT_ID");
  return tenantId;
}

async function expectFullyInViewport(
  locator: Locator,
  label: string,
  viewport: { width: number; height: number },
): Promise<ElementBounds> {
  const bounds = await locator.boundingBox();
  expect(bounds, `${label} should have measurable bounds`).not.toBeNull();
  if (!bounds) throw new Error(`${label} did not have measurable bounds`);

  expect(bounds.x, `${label} left edge should be inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(bounds.y, `${label} top edge should be inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width, `${label} right edge should be inside the viewport`).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height, `${label} bottom edge should be inside the viewport`).toBeLessThanOrEqual(viewport.height);
  return bounds;
}

async function expectFixedControlsVisible(
  page: Page,
  viewport: { width: number; height: number },
  tenantId: string,
): Promise<LayoutSnapshot> {
  const sidebar = page.getByRole("complementary");
  const environmentCard = sidebar.locator(".environment-card");
  const accountArea = sidebar.locator(".sidebar-user");
  const tenantInfo = sidebar.getByText(tenantId, { exact: true });
  const logoutButton = sidebar.getByRole("button", { name: "退出登录" });

  await expect(environmentCard).toContainText("Agent Runtime");
  await expect(tenantInfo).toBeVisible();
  await expect(logoutButton).toBeVisible();

  const sidebarBounds = await expectFullyInViewport(sidebar, "sidebar", viewport);
  expect(sidebarBounds.y, "sidebar should start at the viewport top").toBeCloseTo(0, 1);
  expect(sidebarBounds.height, "sidebar should span the viewport height").toBeCloseTo(viewport.height, 1);
  await expectFullyInViewport(tenantInfo, "tenant information", viewport);
  await expectFullyInViewport(logoutButton, "logout button", viewport);

  return {
    sidebar: sidebarBounds,
    environmentCard: await expectFullyInViewport(environmentCard, "Agent Runtime card", viewport),
    accountArea: await expectFullyInViewport(accountArea, "account area", viewport),
    pageScrollY: await page.evaluate(() => window.scrollY),
    sidebarScrollTop: await sidebar.evaluate(element => element.scrollTop),
  };
}

async function navigationMetrics(navigation: Locator): Promise<NavigationMetrics> {
  return navigation.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
}

async function scrollNavigationToEnd(navigation: Locator): Promise<NavigationMetrics> {
  await navigation.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(
    () => navigation.evaluate(element => element.scrollTop),
    { message: "main navigation should scroll independently" },
  ).toBeGreaterThan(0);

  const metrics = await navigationMetrics(navigation);
  expect(metrics.scrollTop + metrics.clientHeight).toBeGreaterThanOrEqual(metrics.scrollHeight - 1);
  return metrics;
}

function expectPositionUnchanged(before: ElementBounds, after: ElementBounds, label: string): void {
  expect(after.x, `${label} x position should remain stable`).toBeCloseTo(before.x, 1);
  expect(after.y, `${label} y position should remain stable`).toBeCloseTo(before.y, 1);
  expect(after.width, `${label} width should remain stable`).toBeCloseTo(before.width, 1);
  expect(after.height, `${label} height should remain stable`).toBeCloseTo(before.height, 1);
}

function expectLayoutUnchanged(before: LayoutSnapshot, after: LayoutSnapshot): void {
  expectPositionUnchanged(before.sidebar, after.sidebar, "sidebar");
  expectPositionUnchanged(before.environmentCard, after.environmentCard, "Agent Runtime card");
  expectPositionUnchanged(before.accountArea, after.accountArea, "account area");
  expect(after.pageScrollY, "page should not scroll with main navigation").toBe(before.pageScrollY);
  expect(after.sidebarScrollTop, "sidebar should not scroll with main navigation").toBe(before.sidebarScrollTop);
  expect(after.sidebarScrollTop).toBe(0);
}

test(
  "QASEY-2 desktop short viewport keeps fixed sidebar controls visible while navigation scrolls",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-2" },
      { type: "qasey.version", description: "976018ec87f11a8865ca482cf7d50fbc24d22eb3bd85f018361303234cdd3d71" },
    ],
  },
  async ({ page }) => {
    const tenantId = requiredTenantId();
    await page.setViewportSize(desktopViewport);
    await page.goto("/admin/apps/qasey");
    await expect(page).toHaveURL(/\/admin\/apps\/qasey$/u);

    const sidebar = page.getByRole("complementary");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    const lastNavigationItem = navigation.getByRole("button", { name: "Ubuntu 工作台", exact: true });
    await expect(sidebar).toBeVisible();
    await expect(navigation).toBeVisible();
    await expect(lastNavigationItem).toBeAttached();

    const beforeLayout = await expectFixedControlsVisible(page, desktopViewport, tenantId);
    const beforeNavigation = await navigationMetrics(navigation);
    expect(beforeNavigation.scrollHeight).toBeGreaterThan(beforeNavigation.clientHeight);
    expect(beforeNavigation.scrollTop).toBe(0);

    const afterNavigation = await scrollNavigationToEnd(navigation);
    expect(afterNavigation.scrollTop).toBeGreaterThan(0);
    await expect(lastNavigationItem).toBeInViewport({ ratio: 1 });

    const afterLayout = await expectFixedControlsVisible(page, desktopViewport, tenantId);
    expectLayoutUnchanged(beforeLayout, afterLayout);
  },
);

test(
  "QASEY-3 mobile short viewport drawer keeps fixed controls visible while navigation scrolls",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-3" },
      { type: "qasey.version", description: "468be721a1b3eb35b49cef8eb71e4660a056828d383fb69b7ee88fd2633b4ab8" },
    ],
  },
  async ({ page }) => {
    const tenantId = requiredTenantId();
    await page.setViewportSize(mobileViewport);
    await page.goto("/admin/apps/qasey");
    await expect(page).toHaveURL(/\/admin\/apps\/qasey$/u);

    const sidebar = page.getByRole("complementary");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    const lastNavigationItem = navigation.getByRole("button", { name: "Ubuntu 工作台", exact: true });
    const openNavigation = page.getByRole("button", { name: "打开导航" });
    const scrim = page.locator(".sidebar-scrim");

    await expect(sidebar).toBeHidden();
    await expect(openNavigation).toBeVisible();
    await openNavigation.click();

    await expect(sidebar).toBeVisible();
    await expect(navigation).toBeVisible();
    await expect(lastNavigationItem).toBeAttached();
    await expect(scrim).toBeVisible();
    await expect.poll(
      async () => (await sidebar.boundingBox())?.x ?? Number.NEGATIVE_INFINITY,
      { message: "sidebar drawer should finish opening inside the viewport" },
    ).toBeCloseTo(0, 1);
    const closeNavigation = sidebar.getByRole("button", { name: "关闭导航" });
    await expect(closeNavigation).toBeVisible();

    const beforeLayout = await expectFixedControlsVisible(page, mobileViewport, tenantId);
    const beforeNavigation = await navigationMetrics(navigation);
    expect(beforeNavigation.scrollHeight).toBeGreaterThan(beforeNavigation.clientHeight);
    expect(beforeNavigation.scrollTop).toBe(0);

    const afterNavigation = await scrollNavigationToEnd(navigation);
    expect(afterNavigation.scrollTop).toBeGreaterThan(0);
    await expect(lastNavigationItem).toBeInViewport({ ratio: 1 });

    const afterLayout = await expectFixedControlsVisible(page, mobileViewport, tenantId);
    expectLayoutUnchanged(beforeLayout, afterLayout);

    await closeNavigation.click();
    await expect(sidebar).toBeHidden();
    await expect(scrim).toHaveCount(0);
    await expect(openNavigation).toBeVisible();
    await openNavigation.click({ trial: true });
  },
);
