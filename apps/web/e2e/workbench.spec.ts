import { test, expect } from "@playwright/test";

test("工作台加载并显示标题", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "blh 工作台" })).toBeVisible();
});

test("发送消息后展示流式回复", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("你好");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("你好，世界")).toBeVisible();
});
