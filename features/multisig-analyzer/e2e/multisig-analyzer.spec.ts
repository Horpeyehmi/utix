import { expect, test } from "@playwright/test";
import { copy } from "../copy";
import { rawInput, accountJson } from "../fixtures/multisigAnalyzer.fixture";

test("Multisig Signature Weight Analyzer: error recovery and responsive result", async ({ page }, testInfo) => {
  let fail = true;
  await page.route("**/accounts/**", (route) => route.fulfill({ status: fail ? 503 : 200, json: fail ? {} : accountJson(new URL(route.request().url()).pathname.split("/").at(-1)!) }));
  await page.goto("/tools/multisig-analyzer");
  await expect(page.getByRole("heading", { name: "Multisig Signature Weight Analyzer", exact: true })).toBeVisible();
  await page.getByLabel(copy.account, { exact: true }).fill(rawInput.accountId);
  await page.getByLabel(copy.envelope, { exact: true }).fill(rawInput.xdr);
  await page.screenshot({ path: testInfo.outputPath("idle.png"), fullPage: true });
  await page.getByRole("button", { name: copy.submit, exact: true }).click();
  await expect(page.locator('[data-contract-state="error"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("error.png"), fullPage: true });
  fail = false;
  await page.getByRole("button", { name: copy.submit, exact: true }).click();
  await expect(page.getByRole("heading", { name: copy.resultTitle, exact: true })).toBeVisible();
  await expect(page.locator('[data-contract-state="error"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("multisig-analyzer.png"), fullPage: true });
});
