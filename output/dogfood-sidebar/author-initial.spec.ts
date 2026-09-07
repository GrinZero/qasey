import { expect, test, type Locator, type Page } from "@playwright/test";

const sidebarStorageKey = "qasey:sidebar-collapsed";
const caseHubPath = "/admin/apps/qasey/cases";
const runsPath = "/admin/apps/qasey/runs";
const desktopViewport = { width: 1280, height: 900 };

async function expectSidebarLayout(page: Page, width: 238 | 76, mainOffset: 238 | 76 | 0): Promise<void> {
  const sidebar = page.locator("#app-sidebar");
  const main = page.locator("main.main-area");
  await expect(sidebar).toHaveCSS("width", `${width}px`);
  await expect(main).toHaveCSS("margin-left", `${mainOffset}px`);

  if (mainOffset > 0) {
    const [sidebarBox, mainBox] = await Promise.all([sidebar.boundingBox(), main.boundingBox()]);
    expect(sidebarBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    expect(mainBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
  }
}

async function expectToggle(
  toggle: Locator,
  name: "收起侧边栏" | "展开侧边栏",
  expanded: boolean,
): Promise<void> {
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAccessibleName(name);
  await expect(toggle).toHaveAttribute("title", name);
  await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
  await expect(toggle).toHaveAttribute("aria-controls", "app-sidebar");
}

async function expectSingleCurrentNavigation(sidebar: Locator, label: string): Promise<void> {
  const current = sidebar.getByRole("navigation", { name: "主导航" }).locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAccessibleName(label);
}

async function expectRenderedBadgeSemantics(sidebar: Locator): Promise<void> {
  const buttonsWithBadges = sidebar.locator(".nav-button:has(i)");
  const count = await buttonsWithBadges.count();
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox).not.toBeNull();

  for (let index = 0; index < count; index += 1) {
    const button = buttonsWithBadges.nth(index);
    const badge = button.locator("i");
    await expect(badge).toBeVisible();
    const [name, title, badgeText, badgeBox] = await Promise.all([
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      badge.textContent(),
      badge.boundingBox(),
    ]);
    expect(name).toBeTruthy();
    expect(badgeText?.trim()).toMatch(/^\d+$/u);
    expect(title).toBe(`${name}（${badgeText?.trim()}）`);
    expect(badgeBox).not.toBeNull();
    expect(badgeBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x);
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width);
  }
}

async function expectSidebarDetails(sidebar: Locator, visible: boolean): Promise<void> {
  const assertion = visible ? "toBeVisible" : "toBeHidden";
  await expect(sidebar.locator(".brand > div"))[assertion]();
  await expect(sidebar.locator(".nav-label").first())[assertion]();
  await expect(sidebar.locator(".application-nav > span:nth-child(2)").first())[assertion]();
  await expect(sidebar.locator(".application-nav > svg").first())[assertion]();
  await expect(sidebar.locator(".environment-card > div"))[assertion]();
  await expect(sidebar.locator(".sidebar-user > div"))[assertion]();
}

test("QASEY-7 桌面侧栏可收起与展开且图标导航语义保持完整", {
  annotation: [
    { type: "qasey.case", description: "QASEY-7" },
    { type: "qasey.version", description: "6a8436c0cbc32f8ef167989425acab2d0203f0223d2f50737f914b49d7a9d318" },
  ],
}, async ({ page }) => {
  await page.setViewportSize(desktopViewport);
  await page.goto(caseHubPath);
  await page.evaluate(key => window.localStorage.removeItem(key), sidebarStorageKey);
  await page.reload();

  const sidebar = page.locator("#app-sidebar");
  const toggle = page.getByRole("button", { name: "收起侧边栏", exact: true });
  const caseHub = sidebar.getByRole("button", { name: "Case Hub", exact: true });
  const runs = sidebar.getByRole("button", { name: "测试运行", exact: true });

  await test.step("Step 01 · 观察初始桌面侧栏、主内容区和侧栏收起按钮。", async () => {
    await expect(page.getByRole("heading", { name: "Case Hub", exact: true })).toBeVisible();
    await expectSidebarLayout(page, 238, 238);
    await expectToggle(toggle, "收起侧边栏", true);
  });

  await test.step("Step 02 · 点击“收起侧边栏”。", async () => {
    await toggle.click();
    const expandToggle = page.getByRole("button", { name: "展开侧边栏", exact: true });

    await expectSidebarLayout(page, 76, 76);
    await expectSidebarDetails(sidebar, false);
    await expect(caseHub.locator("svg")).toBeVisible();
    await expect(caseHub).toHaveAttribute("title", "Case Hub");
    await expect(caseHub).toHaveAttribute("aria-current", "page");
    await expect(runs).not.toHaveAttribute("aria-current", "page");
    await expectSingleCurrentNavigation(sidebar, "Case Hub");
    await expectRenderedBadgeSemantics(sidebar);
    await expectToggle(expandToggle, "展开侧边栏", false);
  });

  await test.step("Step 03 · 在收起状态下通过“测试运行”图标导航。", async () => {
    await runs.click();

    await expect(page).toHaveURL(new RegExp(`${runsPath}$`, "u"));
    await expect(page.getByRole("heading", { name: "追踪每一次验证" })).toBeVisible();
    await expect(runs).toHaveAccessibleName("测试运行");
    await expect(runs).toHaveAttribute("title", /^测试运行/u);
    await expect(runs).toHaveAttribute("aria-current", "page");
    await expect(caseHub).not.toHaveAttribute("aria-current", "page");
    await expectSingleCurrentNavigation(sidebar, "测试运行");
    await expectRenderedBadgeSemantics(sidebar);
    await expectSidebarLayout(page, 76, 76);
  });

  await test.step("Step 04 · 点击“展开侧边栏”。", async () => {
    const expandToggle = page.getByRole("button", { name: "展开侧边栏", exact: true });
    await expandToggle.click();

    await expectSidebarLayout(page, 238, 238);
    await expectSidebarDetails(sidebar, true);
    await expect(caseHub.locator("svg")).toBeVisible();
    await expectRenderedBadgeSemantics(sidebar);
    await expectToggle(page.getByRole("button", { name: "收起侧边栏", exact: true }), "收起侧边栏", true);
  });
});

test("QASEY-8 桌面侧栏收起状态在刷新后正确持久化", {
  annotation: [
    { type: "qasey.case", description: "QASEY-8" },
    { type: "qasey.version", description: "0ff087f77a2f03d00c10d1a03c6fb5e066d00398fbc5beef94d79ad72a32868c" },
  ],
}, async ({ page }) => {
  await page.setViewportSize(desktopViewport);
  await page.goto(caseHubPath);
  await page.evaluate(key => window.localStorage.removeItem(key), sidebarStorageKey);
  await page.reload();

  await test.step("Step 01 · 确认侧栏初始为完整模式，然后点击“收起侧边栏”。", async () => {
    await expect(page.getByRole("heading", { name: "Case Hub", exact: true })).toBeVisible();
    await expectSidebarLayout(page, 238, 238);
    await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
    await expectSidebarLayout(page, 76, 76);
    await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), sidebarStorageKey)).toBe("true");
  });

  await test.step("Step 02 · 刷新当前页面。", async () => {
    await page.reload();

    await expect(page).toHaveURL(new RegExp(`${caseHubPath}$`, "u"));
    await expect(page.getByRole("heading", { name: "Case Hub", exact: true })).toBeVisible();
    await expectSidebarLayout(page, 76, 76);
    await expectToggle(page.getByRole("button", { name: "展开侧边栏", exact: true }), "展开侧边栏", false);
  });

  await test.step("Step 03 · 点击“展开侧边栏”。", async () => {
    await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();

    await expectSidebarLayout(page, 238, 238);
    await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), sidebarStorageKey)).toBe("false");
  });

  await test.step("Step 04 · 再次刷新当前页面。", async () => {
    await page.reload();

    await expect(page).toHaveURL(new RegExp(`${caseHubPath}$`, "u"));
    await expect(page.getByRole("heading", { name: "Case Hub", exact: true })).toBeVisible();
    await expectSidebarLayout(page, 238, 238);
    await expectToggle(page.getByRole("button", { name: "收起侧边栏", exact: true }), "收起侧边栏", true);
  });
});

test("QASEY-9 已保存的桌面收起状态不影响 780px 移动导航抽屉", {
  annotation: [
    { type: "qasey.case", description: "QASEY-9" },
    { type: "qasey.version", description: "336c4aceb9b8a85ab82f19b78fcb7f5bc27b9eabe784ac9b1f8c2f1f9a5629b7" },
  ],
}, async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 900 });
  await page.goto(caseHubPath);
  await page.evaluate(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: sidebarStorageKey, value: "true" },
  );
  await page.reload();

  const sidebar = page.locator("#app-sidebar");
  const main = page.locator("main.main-area");
  const mobileMenu = page.getByRole("button", { name: "打开导航", exact: true });
  const desktopToggle = page.getByRole("button", { name: "展开侧边栏", exact: true });

  await test.step("Step 01 · 在 780px 宽视口观察顶部控制、主内容区和初始导航状态。", async () => {
    await expect(page.getByRole("heading", { name: "Case Hub", exact: true })).toBeVisible();
    await expect(desktopToggle).toBeHidden();
    await expect(mobileMenu).toBeVisible();
    await expect(main).toHaveCSS("margin-left", "0px");
    await expect(sidebar).toBeHidden();
    await expect(sidebar).toHaveCSS("width", "238px");
    await expect(page.locator(".sidebar-scrim")).toHaveCount(0);
  });

  await test.step("Step 02 · 点击“打开导航”。", async () => {
    await mobileMenu.click();

    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS("width", "238px");
    await expect(page.locator(".sidebar-scrim")).toBeVisible();
    await expectSidebarDetails(sidebar, true);
    await expect(sidebar.getByRole("button", { name: "Case Hub", exact: true }).locator("svg")).toBeVisible();
    await expect(desktopToggle).toBeHidden();
  });

  await test.step("Step 03 · 在移动抽屉中点击“测试运行”。", async () => {
    await sidebar.getByRole("button", { name: "测试运行", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${runsPath}$`, "u"));
    await expect(page.getByRole("heading", { name: "追踪每一次验证" })).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(page.locator(".sidebar-scrim")).toHaveCount(0);
    await expect(main).toHaveCSS("margin-left", "0px");
    await expect(mobileMenu).toBeVisible();
  });

  await test.step("Step 04 · 将视口宽度调整为 781px。", async () => {
    await page.setViewportSize({ width: 781, height: 900 });

    await expect(mobileMenu).toBeHidden();
    await expect(sidebar).toBeVisible();
    await expectSidebarLayout(page, 76, 76);
    await expectToggle(desktopToggle, "展开侧边栏", false);
  });

  await test.step("Step 05 · 将视口宽度调回 780px并再次打开导航。", async () => {
    await page.setViewportSize({ width: 780, height: 900 });

    await expect(main).toHaveCSS("margin-left", "0px");
    await expect(mobileMenu).toBeVisible();
    await expect(desktopToggle).toBeHidden();
    await expect(sidebar).toBeHidden();
    await mobileMenu.click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS("width", "238px");
    await expect(page.locator(".sidebar-scrim")).toBeVisible();
    await expectSidebarDetails(sidebar, true);
  });
});
