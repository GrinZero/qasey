import { expect, test, type Locator, type Page } from "@playwright/test";

const desktopShort = { width: 1280, height: 520 };
const desktopRegular = { width: 1280, height: 900 };
const mobileShort = { width: 390, height: 520 };

interface VerticalBounds {
  top: number;
  bottom: number;
}

function sidebarParts(page: Page) {
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const sidebar = page.locator("aside.sidebar");
  return {
    navigation,
    sidebar,
    runtime: sidebar.locator(".environment-card").filter({ hasText: "Agent Runtime" }),
    account: sidebar.locator(".sidebar-user"),
    logout: sidebar.getByRole("button", { name: "退出登录" }),
  };
}

async function verticalBounds(locator: Locator): Promise<VerticalBounds> {
  const box = await locator.boundingBox();
  expect(box, "the control must have measurable layout bounds").not.toBeNull();
  return { top: box!.y, bottom: box!.y + box!.height };
}

async function expectFullyInViewport(locator: Locator, viewportHeight: number): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport({ ratio: 1 });
  const bounds = await verticalBounds(locator);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(viewportHeight + 1);
}

async function fixedControlPositions(page: Page, viewportHeight: number) {
  const { runtime, account, logout } = sidebarParts(page);
  await expectFullyInViewport(runtime, viewportHeight);
  await expectFullyInViewport(account, viewportHeight);
  await expectFullyInViewport(logout, viewportHeight);
  return {
    runtime: await verticalBounds(runtime),
    account: await verticalBounds(account),
    logout: await verticalBounds(logout),
  };
}

function expectPositionsUnchanged(
  before: Awaited<ReturnType<typeof fixedControlPositions>>,
  after: Awaited<ReturnType<typeof fixedControlPositions>>,
): void {
  for (const name of ["runtime", "account", "logout"] as const) {
    expect(Math.abs(after[name].top - before[name].top), `${name} top must stay fixed`).toBeLessThanOrEqual(1);
    expect(Math.abs(after[name].bottom - before[name].bottom), `${name} bottom must stay fixed`).toBeLessThanOrEqual(1);
  }
}

async function expectNavigationSeparatedFromRuntime(navigation: Locator, runtime: Locator): Promise<void> {
  const navigationBounds = await verticalBounds(navigation);
  const runtimeBounds = await verticalBounds(runtime);
  expect(navigationBounds.bottom, "navigation must not extend underneath the runtime controls").toBeLessThanOrEqual(runtimeBounds.top + 1);
}

async function expectNavigationOverflow(navigation: Locator): Promise<void> {
  await expect(navigation).toBeVisible();
  const metrics = await navigation.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(metrics.scrollHeight, "navigation content must exceed its viewport").toBeGreaterThan(metrics.clientHeight);
  expect(metrics.scrollTop, "navigation must start at the top").toBe(0);
}

async function wheelNavigationToBottom(page: Page, navigation: Locator): Promise<void> {
  await navigation.hover();
  await page.mouse.wheel(0, 10_000);
  await expect.poll(
    () => navigation.evaluate(element => element.scrollTop),
    { message: "wheel input over the navigation must scroll it" },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => navigation.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop),
    { message: "the navigation must be able to reach its bottom" },
  ).toBeLessThanOrEqual(1);
  await page.mouse.wheel(0, 1_000);
}

test(
  "QASEY-1 short desktop sidebar navigation scrolls independently while controls stay visible",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-1" },
      { type: "qasey.version", description: "3e29f7942f029dc235b9aa30a6f84674b0adf6d38a151c8dd7334913c9613538" },
    ],
  },
  async ({ page }) => {
    await page.setViewportSize(desktopShort);
    await page.goto("/admin/apps/qasey");

    const { navigation, sidebar, runtime, account, logout } = sidebarParts(page);
    await expect(page).toHaveURL(/\/admin\/apps\/qasey$/u);
    await expect(page.getByRole("heading", { name: "与 Qasey 一起完成测试任务" })).toBeVisible();
    await expect(sidebar.locator(".brand").getByText("Qasey", { exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /发起工作/u })).toBeVisible();
    await expectFullyInViewport(sidebar, desktopShort.height);

    const controlsBefore = await fixedControlPositions(page, desktopShort.height);
    await expectNavigationSeparatedFromRuntime(navigation, runtime);
    await expectNavigationOverflow(navigation);
    const pageScrollBefore = await page.evaluate(() => window.scrollY);

    await wheelNavigationToBottom(page, navigation);

    expect(await page.evaluate(() => window.scrollY), "the page must not scroll in place of the navigation").toBe(pageScrollBefore);
    const controlsAfter = await fixedControlPositions(page, desktopShort.height);
    expectPositionsUnchanged(controlsBefore, controlsAfter);
    await expect(runtime).toBeVisible();
    await expect(account).toBeVisible();
    await expect(logout).toBeVisible();

    const access = navigation.getByRole("button", { name: "访问与审计", exact: true });
    await expect(access).toBeVisible();
    const accessBounds = await verticalBounds(access);
    const navigationBounds = await verticalBounds(navigation);
    expect(accessBounds.bottom, "the final navigation item must not be covered by fixed controls").toBeLessThanOrEqual(navigationBounds.bottom + 1);

    await access.click();
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    await fixedControlPositions(page, desktopShort.height);
  },
);

test(
  "QASEY-2 regular desktop sidebar shows every region without unnecessary scrolling",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-2" },
      { type: "qasey.version", description: "42c781b7752c8c9fb36f8ee2a212f13f799f0aa250ee365c137fa0469ecc413b" },
    ],
  },
  async ({ page }) => {
    await page.setViewportSize(desktopRegular);
    await page.goto("/admin/apps/qasey");

    const { navigation, sidebar, runtime } = sidebarParts(page);
    const runsLink = navigation.getByRole("button", { name: "测试运行", exact: true });
    const accessLink = navigation.getByRole("button", { name: "访问与审计", exact: true });
    await expect(page.getByRole("heading", { name: "与 Qasey 一起完成测试任务" })).toBeVisible();
    await expect(sidebar.locator(".brand").getByText("Qasey", { exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /发起工作/u })).toBeVisible();
    await expect(navigation.getByText("管理", { exact: true })).toBeVisible();
    await expect(runsLink).toBeVisible();
    await expect(accessLink).toBeVisible();
    await expectFullyInViewport(sidebar, desktopRegular.height);
    const controlsBefore = await fixedControlPositions(page, desktopRegular.height);
    await expectNavigationSeparatedFromRuntime(navigation, runtime);

    const initialMetrics = await navigation.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(initialMetrics.scrollHeight, "regular-height navigation must fit without overflow").toBeLessThanOrEqual(initialMetrics.clientHeight + 1);
    expect(initialMetrics.scrollTop).toBe(0);
    await navigation.hover();
    await page.mouse.wheel(0, 1_000);
    await expect.poll(() => navigation.evaluate(element => element.scrollTop)).toBe(0);

    await runsLink.click();
    await expect(page).toHaveURL(/\/admin\/apps\/qasey\/runs$/u);
    await expect(page.getByRole("heading", { name: "追踪每一次验证", exact: true })).toBeVisible();
    expectPositionsUnchanged(controlsBefore, await fixedControlPositions(page, desktopRegular.height));

    await accessLink.click();
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    expectPositionsUnchanged(controlsBefore, await fixedControlPositions(page, desktopRegular.height));
  },
);

test(
  "QASEY-3 short mobile navigation drawer scrolls and remains closable with account controls available",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-3" },
      { type: "qasey.version", description: "f6c503e944f1e6b20d20bdd569009445d04a600648fe57d94878ec8d75de85db" },
    ],
  },
  async ({ page }) => {
    await page.setViewportSize(mobileShort);
    await page.goto("/admin/apps/qasey");

    const { navigation, sidebar, runtime } = sidebarParts(page);
    const openNavigation = page.getByRole("button", { name: "打开导航" });
    const drawerClose = sidebar.getByRole("button", { name: "关闭导航" });
    const scrim = page.locator(".sidebar-scrim");
    await expect(page.getByRole("heading", { name: "与 Qasey 一起完成测试任务" })).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(openNavigation).toBeVisible();

    await openNavigation.click();
    await expect(sidebar).toBeVisible();
    await expect(drawerClose).toBeVisible();
    await expect(scrim).toBeVisible();
    await expectFullyInViewport(sidebar, mobileShort.height);
    const controlsBefore = await fixedControlPositions(page, mobileShort.height);
    const closeBefore = await verticalBounds(drawerClose);
    await expectNavigationSeparatedFromRuntime(navigation, runtime);
    await expectNavigationOverflow(navigation);
    const pageScrollBefore = await page.evaluate(() => window.scrollY);

    await wheelNavigationToBottom(page, navigation);

    expect(await page.evaluate(() => window.scrollY), "the page must not scroll behind the drawer").toBe(pageScrollBefore);
    expectPositionsUnchanged(controlsBefore, await fixedControlPositions(page, mobileShort.height));
    const closeAfter = await verticalBounds(drawerClose);
    expect(Math.abs(closeAfter.top - closeBefore.top), "the drawer close button must stay fixed").toBeLessThanOrEqual(1);

    await navigation.getByRole("button", { name: "访问与审计", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(scrim).toHaveCount(0);
    await expect(openNavigation).toBeVisible();

    await openNavigation.click();
    await expect(sidebar).toBeVisible();
    await expect(scrim).toBeVisible();
    await drawerClose.click();
    await expect(sidebar).toBeHidden();
    await expect(scrim).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/access$/u);
    await expect(page.getByRole("heading", { name: "访问与审计", exact: true })).toBeVisible();
  },
);
