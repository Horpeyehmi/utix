import { expect, test } from "@playwright/test";
import { copy } from "../copy";
import { rawInput, offersJson, ledgerJson } from "../fixtures/offerInspector.fixture";

test("Account Offers Inspector: error recovery and responsive result", async ({ page }, testInfo) => {
  let fail = true;
  await page.route("**/accounts/**/offers**", (route) => route.fulfill({ status: fail ? 503 : 200, json: fail ? {} : offersJson }));
  await page.route("**/ledgers?**", (route) => route.fulfill({ json: ledgerJson }));
  await page.goto("/tools/offer-inspector");
  await expect(page.getByRole("heading", { name: "Account Offers Inspector", exact: true })).toBeVisible();
  await page.getByLabel(copy.formLabel, { exact: true }).fill(rawInput.accountId);
  await page.screenshot({ path: testInfo.outputPath("idle.png"), fullPage: true });
  await page.getByRole("button", { name: copy.submit, exact: true }).click();
  await expect(page.locator('[data-contract-state="error"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("error.png"), fullPage: true });
  fail = false;
  await page.getByRole("button", { name: copy.submit, exact: true }).click();
  await expect(page.getByRole("heading", { name: copy.resultTitle, exact: true })).toBeVisible();
  await expect(page.locator('[data-contract-state="error"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("offer-inspector.png"), fullPage: true });
});
