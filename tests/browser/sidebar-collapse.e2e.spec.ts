import { expect, test, type Locator, type Page } from "@playwright/test";

const sidebarPreferenceKey = "qasey:sidebar-collapsed";
const desktopViewport = { width: 1280, height: 900 };

function sidebar(page: Page): Locator {
  return page.locator("#app-sidebar");
}

function mainArea(page: Page): Locator {
  return page.locator("main.main-area");
}

async function expectDesktopSidebarWidth(page: Page, width: "76px" | "238px"): Promise<void> {
  await expect(sidebar(page)).toHaveCSS("width", width);
  await expect(mainArea(page)).toHaveCSS("margin-left", width);
}

function runsNavigation(page: Page): Locator {
  return page.getByRole("button", { name: "测试运行", exact: true });
}

function mainNavigation(page: Page): Locator {
  return sidebar(page).getByRole("navigation", { name: "主导航", exact: true });
}

function navigationCopy(page: Page): Locator {
  return mainNavigation(page).locator(".nav-label, .nav-button > span, .application-nav > span:nth-child(2)");
}

function sidebarSecondaryCopy(page: Page): Locator {
  return sidebar(page).locator(".brand > div, .environment-card > div, .sidebar-user > div");
}

async function expectEvery(locator: Locator, state: "visible" | "hidden"): Promise<void> {
  const count = await locator.count();
  expect(count, `expected at least one ${state} element`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    if (state === "visible") await expect(locator.nth(index)).toBeVisible();
    else await expect(locator.nth(index)).toBeHidden();
  }
}

async function navigationLabels(page: Page): Promise<string[]> {
  return mainNavigation(page).getByRole("button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label") ?? ""));
}

async function expectStableNavigationLabels(page: Page, expectedLabels: string[]): Promise<void> {
  const buttons = mainNavigation(page).getByRole("button");
  await expect(buttons).toHaveCount(expectedLabels.length);
  for (let index = 0; index < expectedLabels.length; index += 1) {
    await expect(buttons.nth(index)).toBeVisible();
    await expect(buttons.nth(index)).toHaveAttribute("aria-label", expectedLabels[index]!);
  }
}

async function expectNonZeroBadgesInsideButtons(page: Page): Promise<void> {
  const badges = mainNavigation(page).locator(".nav-button > i");
  await expect(badges.first(), "at least one live non-zero navigation badge must be rendered").toBeVisible();
  const badgeCount = await badges.count();
  expect(badgeCount).toBeGreaterThan(0);

  for (let index = 0; index < badgeCount; index += 1) {
    const badge = badges.nth(index);
    const button = badge.locator("..");
    const icon = button.locator("svg");
    const badgeText = (await badge.textContent())?.trim() ?? "";
    const label = await button.getAttribute("aria-label");

    expect(badgeText).toMatch(/^[1-9]\d*$/u);
    expect(label).toBeTruthy();
    await expect(button).toHaveAttribute("title", `${label}（${badgeText}）`);

    const [buttonBox, iconBox, badgeBox] = await Promise.all([
      button.boundingBox(),
      icon.boundingBox(),
      badge.boundingBox(),
    ]);
    expect(buttonBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    expect(badgeBox).not.toBeNull();
    if (!buttonBox || !iconBox || !badgeBox) throw new Error("Visible navigation badge geometry is unavailable");

    expect(badgeBox.x).toBeGreaterThanOrEqual(buttonBox.x - 0.5);
    expect(badgeBox.y).toBeGreaterThanOrEqual(buttonBox.y - 0.5);
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(buttonBox.x + buttonBox.width + 0.5);
    expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(buttonBox.y + buttonBox.height + 0.5);
    expect(badgeBox.x).toBeGreaterThanOrEqual(iconBox.x + iconBox.width);
  }
}

async function clearSidebarPreference(page: Page): Promise<void> {
  await page.evaluate(key => window.localStorage.removeItem(key), sidebarPreferenceKey);
}

async function sidebarPreference(page: Page): Promise<string | null> {
  return page.evaluate(key => window.localStorage.getItem(key), sidebarPreferenceKey);
}

test(
  "QASEY-7 · 桌面侧栏可收起与展开且图标导航语义保持完整",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-7" },
      { type: "qasey.version", description: "319038821f01031fe532c022aac670911d67945daded69a01e93d5bbde2094bb" },
    ],
  },
  async ({ page }) => {
    let expectedNavigationLabels: string[] = [];

    await test.step("Step 01 · 打开 /admin/apps/qasey，检查桌面侧栏和顶部的侧栏切换按钮。", async () => {
      await page.setViewportSize(desktopViewport);
      await page.goto("/admin/apps/qasey");
      await clearSidebarPreference(page);
      await page.reload();

      const collapseButton = page.getByRole("button", { name: "收起侧边栏", exact: true });
      const qaseyApplication = mainNavigation(page).getByRole("button", { name: "Qasey", exact: true });
      await expect(sidebar(page)).toBeVisible();
      await expectDesktopSidebarWidth(page, "238px");
      await expect(qaseyApplication).toBeVisible();
      await expect(qaseyApplication).toHaveAttribute("aria-label", "Qasey");
      await expectEvery(navigationCopy(page), "visible");
      await expectEvery(sidebarSecondaryCopy(page), "visible");
      await expect(runsNavigation(page).locator("svg")).toBeVisible();
      await expect(collapseButton).toBeVisible();
      await expect(collapseButton).toHaveAttribute("title", "收起侧边栏");
      await expect(collapseButton).toHaveAttribute("aria-expanded", "true");
      await expect(collapseButton).toHaveAttribute("aria-controls", "app-sidebar");

      expectedNavigationLabels = await navigationLabels(page);
      expect(expectedNavigationLabels.length).toBeGreaterThan(0);
      expect(expectedNavigationLabels.every(label => label.length > 0)).toBe(true);
      expect(new Set(expectedNavigationLabels).size).toBe(expectedNavigationLabels.length);
      expect(expectedNavigationLabels).toEqual(expect.arrayContaining([
        "平台首页",
        "待处理",
        "活动",
        "Qasey",
        "工作台",
        "Case Hub",
        "测试运行",
        "待我审阅",
      ]));
    });

    await test.step("Step 02 · 点击“收起侧边栏”。", async () => {
      await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();

      const expandButton = page.getByRole("button", { name: "展开侧边栏", exact: true });
      const runsButton = runsNavigation(page);
      const qaseyApplication = mainNavigation(page).getByRole("button", { name: "Qasey", exact: true });
      await expectDesktopSidebarWidth(page, "76px");
      await expectStableNavigationLabels(page, expectedNavigationLabels);
      await expectEvery(mainNavigation(page).locator(".nav-button > svg, .application-nav .app-glyph > svg"), "visible");
      await expectEvery(navigationCopy(page), "hidden");
      await expectEvery(sidebarSecondaryCopy(page), "hidden");
      await expect(qaseyApplication).toBeVisible();
      await expect(qaseyApplication).toHaveAttribute("aria-label", "Qasey");
      await expect(runsButton).toHaveAttribute("aria-label", "测试运行");
      await expect(runsButton).toHaveAttribute("title", /^测试运行(?:（\d+）)?$/u);
      await expectNonZeroBadgesInsideButtons(page);
      await expect(expandButton).toHaveAttribute("title", "展开侧边栏");
      await expect(expandButton).toHaveAttribute("aria-expanded", "false");
    });

    await test.step("Step 03 · 通过收起侧栏中的“测试运行”图标按钮进入测试运行页。", async () => {
      const runsButton = runsNavigation(page);
      await runsButton.click();

      await expect(page).toHaveURL(/\/admin\/apps\/qasey\/runs$/u);
      await expect(page.getByRole("heading", { name: "追踪每一次验证", exact: true })).toBeVisible();
      await expect(runsButton).toHaveAttribute("aria-current", "page");
      await expect(runsButton).toHaveAttribute("aria-label", "测试运行");
      await expect(runsButton).toHaveAttribute("title", /^测试运行(?:（\d+）)?$/u);
    });

    await test.step("Step 04 · 点击“展开侧边栏”。", async () => {
      await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();

      const collapseButton = page.getByRole("button", { name: "收起侧边栏", exact: true });
      await expectDesktopSidebarWidth(page, "238px");
      await expectStableNavigationLabels(page, expectedNavigationLabels);
      await expectEvery(mainNavigation(page).locator(".nav-button > svg, .application-nav .app-glyph > svg"), "visible");
      await expectEvery(navigationCopy(page), "visible");
      await expectEvery(sidebarSecondaryCopy(page), "visible");
      await expectNonZeroBadgesInsideButtons(page);
      await expect(page.getByText("Application platform", { exact: true })).toBeVisible();
      await expect(collapseButton).toHaveAttribute("title", "收起侧边栏");
      await expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    });
  },
);

test(
  "QASEY-8 · 桌面侧栏收起状态在刷新后正确持久化",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-8" },
      { type: "qasey.version", description: "6bb1ef928cca7a900a56b02d520a289d78aa25a40630d80bdc450b486e6244b2" },
    ],
  },
  async ({ page }) => {
    await test.step("Step 01 · 清除 localStorage 的 qasey:sidebar-collapsed，打开 /admin/apps/qasey，并点击“收起侧边栏”。", async () => {
      await page.setViewportSize(desktopViewport);
      await page.goto("/admin/apps/qasey");
      await clearSidebarPreference(page);
      await page.reload();
      await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();

      const expandButton = page.getByRole("button", { name: "展开侧边栏", exact: true });
      await expectDesktopSidebarWidth(page, "76px");
      await expect(expandButton).toHaveAttribute("aria-expanded", "false");
      expect(await sidebarPreference(page)).toBe("true");
    });

    await test.step("Step 02 · 刷新当前页面。", async () => {
      await page.reload();

      await expect(page).toHaveURL(/\/admin\/apps\/qasey$/u);
      await expectDesktopSidebarWidth(page, "76px");
      await expect(runsNavigation(page).locator("span")).toBeHidden();
      await expect(page.getByRole("button", { name: "展开侧边栏", exact: true })).toHaveAttribute("aria-expanded", "false");
    });

    await test.step("Step 03 · 点击“展开侧边栏”，并检查存储值。", async () => {
      await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();

      const collapseButton = page.getByRole("button", { name: "收起侧边栏", exact: true });
      await expectDesktopSidebarWidth(page, "238px");
      await expect(collapseButton).toHaveAttribute("aria-expanded", "true");
      expect(await sidebarPreference(page)).toBe("false");
    });

    await test.step("Step 04 · 再次刷新当前页面。", async () => {
      await page.reload();

      await expect(page).toHaveURL(/\/admin\/apps\/qasey$/u);
      await expectDesktopSidebarWidth(page, "238px");
      await expect(runsNavigation(page).locator("span")).toBeVisible();
      await expect(page.getByText("Application platform", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "收起侧边栏", exact: true })).toHaveAttribute("aria-expanded", "true");
    });
  },
);

test(
  "QASEY-9 · 已保存的桌面收起状态不影响 780px 移动导航抽屉",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-9" },
      { type: "qasey.version", description: "73f598a785d7991332629ae4594d67b958fd8c88b2a7e460b8654bd8225409fe" },
    ],
  },
  async ({ page }) => {
    await test.step("Step 01 · 在 1280px 宽度打开 /admin/apps/qasey，收起桌面侧栏并确认 localStorage[\"qasey:sidebar-collapsed\"] 为 \"true\"。", async () => {
      await page.setViewportSize(desktopViewport);
      await page.goto("/admin/apps/qasey");
      await clearSidebarPreference(page);
      await page.reload();
      await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();

      const expandButton = page.getByRole("button", { name: "展开侧边栏", exact: true });
      await expectDesktopSidebarWidth(page, "76px");
      await expect(expandButton).toHaveAttribute("aria-expanded", "false");
      expect(await sidebarPreference(page)).toBe("true");
    });

    await test.step("Step 02 · 将视口调整为 780px。", async () => {
      await page.setViewportSize({ width: 780, height: 900 });

      await expect(page.getByRole("button", { name: "展开侧边栏", exact: true })).toBeHidden();
      await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeVisible();
      await expect(sidebar(page)).toBeHidden();
      await expect(mainArea(page)).toHaveCSS("margin-left", "0px");
    });

    await test.step("Step 03 · 点击“打开导航”，检查抽屉中的导航内容，然后通过“关闭导航”或遮罩关闭抽屉。", async () => {
      await page.getByRole("button", { name: "打开导航", exact: true }).click();

      const mobileSidebar = sidebar(page);
      const runsButton = runsNavigation(page);
      await expect(mobileSidebar).toBeVisible();
      await expect(mobileSidebar).toHaveCSS("width", "238px");
      await expect(page.getByText("Application platform", { exact: true })).toBeVisible();
      await expect(runsButton).toBeVisible();
      await expect(runsButton.locator("svg")).toBeVisible();
      await expect(runsButton.locator("span")).toBeVisible();
      await expect(runsButton).toHaveAttribute("aria-label", "测试运行");
      expect(await sidebarPreference(page)).toBe("true");

      await mobileSidebar.getByRole("button", { name: "关闭导航", exact: true }).click();
      await expect(mobileSidebar).toBeHidden();
      expect(await sidebarPreference(page)).toBe("true");
    });

    await test.step("Step 04 · 将视口调整为 781px。", async () => {
      await page.setViewportSize({ width: 781, height: 900 });

      await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeHidden();
      await expect(sidebar(page).getByRole("button", { name: "关闭导航", exact: true })).toBeHidden();
      const expandButton = page.getByRole("button", { name: "展开侧边栏", exact: true });
      await expect(expandButton).toBeVisible();
      await expect(expandButton).toHaveAttribute("aria-expanded", "false");
      await expect(sidebar(page)).toBeVisible();
      await expectDesktopSidebarWidth(page, "76px");
      await expect(runsNavigation(page).locator("span")).toBeHidden();
      expect(await sidebarPreference(page)).toBe("true");
    });
  },
);
