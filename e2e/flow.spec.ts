/**
 * The whole app, driven through the browser — the UI half of the Python
 * app's tests/fake_run.py (stages, one-question-at-a-time, start-over
 * confirmation), plus what only a web app can get wrong (reload, double calls).
 */

import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { mockApi } from "./mockApi";

const QUESTIONS = 7; // deliberately not the default of 5

async function fetchPosting(page: Page) {
  await page.getByLabel("Link to the job posting").fill("https://careers.example.com/jobs/1");
  await page.getByRole("button", { name: "Fetch the posting" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Data Engineer @ Acme GmbH" })).toBeVisible();
}

async function setUpInterview(page: Page, total = QUESTIONS) {
  await page.getByRole("button", { name: "Start a mock interview" }).click();
  await expect(page.getByRole("heading", { name: "Set up your mock interview" })).toBeVisible();
  const field = page.getByLabel("How many questions?");
  await field.fill(String(total));
  await field.blur();
}

async function answer(page: Page, text: string) {
  const box = page.getByLabel("Your answer");
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press("Enter");
}

test("a full interview, from link to report", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");

  // -- step 1 ---------------------------------------------------------------
  await expect(page.getByRole("heading", { name: "Prepare for a real interview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start over" })).toHaveCount(0); // nothing to clear yet

  // The model chosen here must reach the request.
  await page.getByRole("button", { name: /Model and tuning/ }).click();
  await page.getByRole("radio", { name: /GPT-5 nano/ }).click();
  await page.getByRole("radio", { name: "low", exact: true }).click();
  await fetchPosting(page);
  expect(calls.job[0].postDataJSON().settings).toMatchObject({ model: "openai/gpt-5-nano", reasoning_effort: "low" });

  // -- step 2 ---------------------------------------------------------------
  await expect(page.getByText("Translated from German into English.")).toBeVisible();
  await expect(page.getByText("This page tried to give instructions to the model.")).toBeVisible();
  await page.getByRole("button", { name: /Read the original German posting/ }).click();
  await expect(page.getByText("Daten modellieren")).toBeVisible();
  await page.getByRole("tab", { name: /Key skills/ }).click();
  await expect(page.getByText("Taken word-for-word from the posting")).toBeVisible();
  await page.getByRole("tab", { name: /Study plan/ }).click();
  await expect(page.getByText("Drill SQL under time pressure")).toBeVisible();

  // -- step 3: the split preview follows the count live ----------------------
  await page.getByRole("button", { name: "Start a mock interview" }).click();
  await page.getByRole("radio", { name: /German/ }).click();
  await page.getByRole("radio", { name: /Hard/ }).click();
  await page.getByRole("radio", { name: /Strict/ }).click();
  const field = page.getByLabel("How many questions?");
  for (const [n, t, b] of [
    [3, 1, 1],
    [4, 2, 1],
    [QUESTIONS, 3, 3],
  ]) {
    await field.fill(String(n));
    await expect(page.getByText(`That's 1 self-introduction, ${t} technical and ${b} behavioural.`)).toBeVisible();
  }
  await page.getByRole("button", { name: "Begin the interview" }).click();

  // -- step 4: one question at a time ----------------------------------------
  await expect(page.getByText(`Question 1 of ${QUESTIONS} · Self-introduction`)).toBeVisible();
  expect(calls.question).toHaveLength(1);
  expect(calls.question[0].postDataJSON().interview).toEqual({ language: "German", difficulty: "Hard", attitude: "Strict", num_questions: QUESTIONS });

  for (let i = 1; i <= QUESTIONS; i++) {
    await expect(page.getByText(`Question ${i} of ${QUESTIONS} ·`)).toBeVisible();
    // Exactly one question is waiting — never generated ahead.
    await expect(page.getByText(new RegExp(`^Question \\d+ of ${QUESTIONS} ·`))).toHaveCount(i);
    await answer(page, `This is my answer number ${i}.`);
  }

  // -- step 5 -------------------------------------------------------------
  await expect(page.getByRole("heading", { name: "Your interview report" })).toBeVisible({ timeout: 20_000 });
  expect(calls.question).toHaveLength(QUESTIONS);
  expect(calls.evaluate).toHaveLength(QUESTIONS);
  expect(calls.summary).toHaveLength(1);
  expect(calls.job).toHaveLength(1);
  // Each answer was sent to be scored exactly once, in order.
  expect(calls.evaluate.map((r) => r.postDataJSON().turn.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);

  await expect(page.getByText("Solid technical grounding; make your stories more specific.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What worked" })).toBeVisible();
  await expect(page.getByText("Score per question (out of 10)")).toBeVisible();
  await expect(page.locator(".recharts-bar-rectangle")).toHaveCount(QUESTIONS);
  await expect(page.locator(".recharts-radar")).toHaveCount(3);

  await page.getByRole("button", { name: /^Q2/ }).click();
  // Only the opened answer shows its detail.
  await expect(page.getByText("Stronger version of the answer").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText(/\[e\.g\. 40 million rows\]/).filter({ visible: true })).toHaveCount(1);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download data (JSON)" }).click();
  expect((await download).suggestedFilename()).toBe("interview_report.json");

  // The PDF comes from the real /api/report route — it needs no model, so it
  // isn't mocked. It must be a real PDF file, not a print of the page.
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report (PDF)" }).click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toMatch(/^data-engineer-acme-gmbh-report-\d{8}\.pdf$/);
  const bytes = readFileSync((await pdf.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

  // Practising again needs a second click, and keeps the role.
  await page.getByRole("button", { name: "Practise this role again" }).click();
  await expect(page.getByText("This discards the report above")).toBeVisible();
  await page.getByRole("button", { name: "Yes, new interview" }).click();
  await expect(page.getByRole("heading", { name: "Set up your mock interview" })).toBeVisible();
});

test("start over asks first, says what is at stake, and resets", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await fetchPosting(page);

  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByText("This clears the job description and study plan")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Data Engineer @ Acme GmbH" })).toBeVisible();

  // Mid-interview, the warning counts the answers at risk.
  await setUpInterview(page);
  await page.getByRole("button", { name: "Begin the interview" }).click();
  await answer(page, "An answer.");
  await expect(page.getByText(`Question 2 of ${QUESTIONS} ·`)).toBeVisible();
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByText(`You're 1 of ${QUESTIONS} answers into this interview.`)).toBeVisible();
  await page.getByRole("button", { name: "Yes, start over" }).click();

  await expect(page.getByRole("heading", { name: "Prepare for a real interview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start over" })).toHaveCount(0);
});

test("a reload mid-interview resumes where it stopped, without asking twice", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");
  await fetchPosting(page);
  await setUpInterview(page, 3);
  await page.getByRole("button", { name: "Begin the interview" }).click();
  await answer(page, "First answer.");
  await expect(page.getByText("Question 2 of 3 ·")).toBeVisible();
  const asked = calls.question.length;

  await page.reload();
  await expect(page.getByText("First answer.")).toBeVisible();
  await expect(page.getByText("Question 2 of 3 ·")).toBeVisible();
  await expect(page.getByLabel("Your answer")).toBeEnabled();
  expect(calls.question.length).toBe(asked); // the waiting question was not re-asked
});

test("a blocked link falls back to pasting, which then works", async ({ page }) => {
  const calls = await mockApi(page, { failFetch: true });
  await page.goto("/");
  await page.getByLabel("Link to the job posting").fill("https://www.linkedin.com/jobs/view/1");
  await page.getByRole("button", { name: "Fetch the posting" }).click();

  await expect(page.getByText("linkedin.com blocks automated page fetches")).toBeVisible();
  const box = page.getByLabel("Job description");
  await expect(box).toBeFocused();

  await box.fill("Too short.");
  await page.getByRole("button", { name: "Use this text" }).click();
  await expect(page.getByText("That's very short")).toBeVisible();
  expect(calls.job).toHaveLength(1); // the short paste never left the browser

  await box.fill("We are hiring a Data Engineer to build batch pipelines in Python and SQL. ".repeat(3));
  await page.getByRole("button", { name: "Use this text" }).click();
  await expect(page.getByRole("heading", { name: "Data Engineer @ Acme GmbH" })).toBeVisible();
  expect(calls.job[1].postDataJSON().text).toContain("We are hiring");
});

test("ending an interview early goes back to the posting and keeps the plan", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await fetchPosting(page);
  await setUpInterview(page, 3);
  await page.getByRole("button", { name: "Begin the interview" }).click();
  await expect(page.getByText("Question 1 of 3 ·")).toBeVisible();
  await page.getByRole("button", { name: "End without scoring" }).click();
  await page.getByRole("button", { name: "Yes, end it" }).click();
  await expect(page.getByRole("heading", { name: "Data Engineer @ Acme GmbH" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Study plan/ })).toBeVisible();
});

test("with an access code configured, the app asks for it first", async ({ page }) => {
  await mockApi(page);
  let unlocked = false;
  await page.route("**/api/session", (route) => route.fulfill({ json: { required: true, authorised: unlocked } }));
  await page.route("**/api/login", async (route) => {
    const { code } = route.request().postDataJSON() as { code: string };
    if (code === "open-sesame") {
      unlocked = true;
      await route.fulfill({ json: { ok: true, required: true } });
    } else {
      await route.fulfill({ status: 401, json: { ok: false, stage: "auth", error: "That access code isn't right." } });
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Enter the access code" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prepare for a real interview" })).toHaveCount(0);

  await page.getByLabel("Access code").fill("wrong");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That access code isn't right.")).toBeVisible();

  await page.getByLabel("Access code").fill("open-sesame");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Prepare for a real interview" })).toBeVisible();
});

test("a refused request shows the gate again, and a rate limit explains itself", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  // Over the limit: the server's message is shown as it is.
  await page.route("**/api/job", (route) =>
    route.fulfill({
      status: 429,
      json: { ok: false, stage: "rate_limit", error: "You've reached this hour's limit of model calls. Please try again in 12 minutes." },
    }),
  );
  await page.getByLabel("Link to the job posting").fill("https://careers.example.com/jobs/1");
  await page.getByRole("button", { name: "Fetch the posting" }).click();
  await expect(page.getByText("Please try again in 12 minutes.")).toBeVisible();

  // The code was changed on the server: the next call brings the gate back.
  await page.route("**/api/job", (route) =>
    route.fulfill({ status: 401, json: { ok: false, stage: "auth", error: "This app needs an access code. Enter it to continue." } }),
  );
  await page.getByRole("button", { name: "Fetch the posting" }).click();
  await expect(page.getByRole("heading", { name: "Enter the access code" })).toBeVisible();
});
