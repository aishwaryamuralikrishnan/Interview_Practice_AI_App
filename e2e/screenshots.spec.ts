/**
 * Not a test: walks every stage and saves full-page screenshots, light and
 * dark, desktop and phone. Skipped unless asked for:
 *
 *   SCREENSHOTS=1 npm run e2e -- screenshots
 *
 * Output: screenshots/<theme>-<device>-<stage>.png
 */

import { test, type Page } from "@playwright/test";

import { mockApi } from "./mockApi";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture screenshots");

const VIEWS = [
  { name: "desktop", viewport: { width: 1280, height: 860 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];

for (const theme of ["light", "dark"] as const) {
  for (const view of VIEWS) {
    test(`${theme} ${view.name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: view.viewport, colorScheme: theme, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await mockApi(page, { delayMs: 50 });
      const shot = async (stage: string) => {
        // No page may scroll sideways, at any width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) throw new Error(`${stage} overflows horizontally by ${overflow}px`);
        await page.screenshot({ path: `screenshots/${theme}-${view.name}-${stage}.png`, fullPage: true, animations: "disabled" });
      };

      await page.goto("/");
      await page.getByRole("button", { name: /Model and tuning/ }).click();
      await shot("1-posting");

      await page.getByLabel("Link to the job posting").fill("https://careers.example.com/jobs/1");
      await page.getByRole("button", { name: "Fetch the posting" }).click();
      await page.getByRole("heading", { name: "Data Engineer @ Acme GmbH" }).waitFor();
      await shot("2-review");

      await page.getByRole("button", { name: "Start a mock interview" }).click();
      await page.getByLabel("How many questions?").fill("5");
      await shot("3-setup");

      await page.getByRole("button", { name: "Begin the interview" }).click();
      await answerNext(page, "I've spent four years building data pipelines for a medical-records company, mostly Python and Airflow on Postgres, and I'm looking for a larger analytics platform.");
      await answerNext(page, "I'd MERGE on the business key plus the load date, so a second run updates rather than duplicates, and write a run marker so a re-trigger exits early.");
      await page.getByText("Question 3 of 5 ·").waitFor();
      await page.waitForTimeout(800); // let the smooth scroll to the new question finish
      await page.screenshot({ path: `screenshots/${theme}-${view.name}-4-interview-viewport.png`, animations: "disabled" });
      await shot("4-interview");

      for (let i = 3; i <= 5; i++) await answerNext(page, `Answer number ${i}, with a concrete example and a result.`);
      await page.getByRole("heading", { name: "Your interview report" }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: /^Q2/ }).click();
      await page.waitForTimeout(300);
      await shot("5-results");
      await page.locator("figure").nth(1).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `screenshots/${theme}-${view.name}-5-results-charts.png`, animations: "disabled" });
      await context.close();
    });
  }
}

async function answerNext(page: Page, text: string) {
  const box = page.getByLabel("Your answer");
  await box.waitFor();
  await page.waitForFunction(() => !(document.getElementById("answer") as HTMLTextAreaElement | null)?.disabled);
  await box.fill(text);
  await box.press("Enter");
}
