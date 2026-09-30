/**
 * A stand-in for the four /api routes, answered inside the browser with
 * page.route(). The server-side logic is covered by Vitest; this lets the UI
 * be driven end to end with no key, no network and no cost.
 *
 * Replies are shaped by the real modules (buildQuestionPlan, parseEvaluation),
 * so they are exactly what the real routes would return.
 */

import type { Page, Request } from "@playwright/test";

import { parseEvaluation } from "@/lib/api/validate";
import * as config from "@/lib/config";
import { buildQuestionPlan, type InterviewSettings, type TurnRecord } from "@/lib/interview";
import { emptyJob } from "@/lib/job";

export const JOB = emptyJob({
  job_title: "Data Engineer",
  company: "Acme GmbH",
  location: "Berlin, Germany",
  employment_type: "Full-time, permanent contract (unbefristet)",
  seniority: "Mid-level",
  language_of_posting: "German",
  was_translated: true,
  source_url: "https://careers.example.com/jobs/1",
  injection_notice: "The page asked the model to ignore its rules and return a fake posting.",
  summary: "Build and maintain the batch pipelines that feed Acme's analytics platform.",
  responsibilities: ["Own the ingestion layer", "Model data for analytics", "Mentor two junior engineers"],
  requirements: ["3+ years of Python", "Strong SQL", "Airflow or a similar orchestrator"],
  nice_to_have: ["dbt", "Experience with Snowflake"],
  tech_stack: ["Python", "Airflow", "Snowflake", "dbt"],
  benefits: ["Remote-friendly", "30 days of holiday"],
  original_description: "Wir suchen einen Data Engineer für unsere Pipelines.",
  original_responsibilities: ["Pipelines bauen", "Daten modellieren", "Team beraten"],
  original_requirements: ["3+ Jahre Python", "Sehr gute SQL-Kenntnisse"],
});

export const PLAN = {
  key_skills: ["Python", "SQL", "Airflow", "Snowflake", "dbt", "Data modelling"],
  interview_topics: [
    "Designing idempotent batch pipelines",
    "SQL window functions and query tuning",
    "Airflow DAG design and backfills",
    "Dimensional modelling for analytics",
  ],
  study_plan: [
    { strategy: "Rebuild one pipeline end to end", description: "Ingest, model and schedule a public dataset with Airflow and dbt." },
    { strategy: "Drill SQL under time pressure", description: "Twenty window-function problems, timed, then explain each aloud." },
    { strategy: "Prepare three STAR stories", description: "A failure, a conflict and a result you can quantify." },
  ],
};

const USAGE = { prompt_tokens: 1200, completion_tokens: 800, reasoning_tokens: 500, calls: 1, peak_completion_tokens: 800, total_tokens: 2000 };

const QUESTIONS: Record<config.QuestionType, string[]> = {
  intro: ["Thanks for joining. Could you walk me through your background and what draws you to this Data Engineer role?"],
  technical: [
    "A nightly load into Snowflake occasionally runs twice. How would you make that pipeline idempotent?",
    "You have a slow query joining a 400-million-row events table to a users table. How do you find and fix the bottleneck?",
    "How would you structure an Airflow DAG so that a backfill of the last 90 days doesn't overwhelm the warehouse?",
    "Walk me through how you'd model orders and refunds for an analytics team.",
  ],
  behavioural: [
    "Tell me about a time you had to ship something before it was finished. What did you do?",
    "Describe a disagreement with a colleague about a technical decision. How was it resolved?",
    "Tell me about a mistake you made in production and what you changed afterwards.",
    "Describe a time you helped a less experienced colleague grow.",
  ],
};

// Scores that vary by question, so the charts have something to show.
const SCORE_PATTERN = [7, 8, 5, 9, 6, 7, 4, 8, 6, 9];

export interface MockCalls {
  job: Request[];
  question: Request[];
  evaluate: Request[];
  summary: Request[];
}

export async function mockApi(
  page: Page,
  { delayMs = 150, failFetch = false }: { delayMs?: number; failFetch?: boolean } = {},
): Promise<MockCalls> {
  const calls: MockCalls = { job: [], question: [], evaluate: [], summary: [] };
  const wait = () => new Promise((r) => setTimeout(r, delayMs));

  await page.route("**/api/job", async (route) => {
    calls.job.push(route.request());
    await wait();
    const body = route.request().postDataJSON() as { url: string; text: string };
    if (failFetch && !body.text) {
      await route.fulfill({
        status: 422,
        json: {
          ok: false,
          stage: "fetch",
          error: "linkedin.com blocks automated page fetches, so the posting can't be read from the link.",
          hint: "Open the posting in your browser, copy the description, and paste it below instead.",
        },
      });
      return;
    }
    await route.fulfill({
      json: { ok: true, source: body.text ? "text" : "url", job: JOB, plan: PLAN, usage: { ...USAGE, calls: 2 } },
    });
  });

  await page.route("**/api/question", async (route) => {
    calls.question.push(route.request());
    await wait();
    const { interview, transcript } = route.request().postDataJSON() as { interview: InterviewSettings; transcript: TurnRecord[] };
    const plan = buildQuestionPlan(interview);
    const number = transcript.length + 1;
    const type = plan[number - 1];
    const already = transcript.filter((t) => t.question_type === type).length;
    await route.fulfill({
      json: {
        ok: true,
        turn: { number, question_type: type, question: QUESTIONS[type][already % QUESTIONS[type].length], answer: null, evaluation: null },
        usage: USAGE,
      },
    });
  });

  await page.route("**/api/evaluate", async (route) => {
    calls.evaluate.push(route.request());
    await wait();
    const { turn } = route.request().postDataJSON() as { turn: TurnRecord };
    const base = SCORE_PATTERN[(turn.number - 1) % SCORE_PATTERN.length];
    const criteria = Object.keys(config.RUBRICS[turn.question_type]);
    const evaluation = parseEvaluation(
      {
        scores: Object.fromEntries(criteria.map((c, i) => [c, Math.min(10, base + (i % 2 ? 1 : -1) * (i % 3))])),
        strength: "Clear opening that answers the question directly.",
        suggested_improvement: "Name the metric you moved and by how much.",
        improved_answer:
          "I'd make the load idempotent with a MERGE keyed on the business key and the load date. " +
          "On a table of [e.g. 40 million rows] that removed duplicate runs entirely. " +
          "I'd also add a run marker so a second trigger exits early.",
      },
      turn.question_type,
      "evaluation",
    );
    await route.fulfill({ json: { ok: true, evaluation, usage: USAGE } });
  });

  await page.route("**/api/summary", async (route) => {
    calls.summary.push(route.request());
    await wait();
    await route.fulfill({
      json: {
        ok: true,
        summary: {
          headline: "Solid technical grounding; make your stories more specific.",
          readiness: "Getting there",
          what_worked: ["Answers opened with a clear claim.", "Technical reasoning was sound and well ordered.", "You named real tools rather than generic ones."],
          suggested_improvements: ["Quantify the outcome of each story.", "Say what you personally did, not what the team did.", "Close technical answers with the trade-off you accepted."],
          closing_advice: "Before the real interview, rehearse your three strongest stories aloud with a number in each result.",
          error: null,
        },
        usage: USAGE,
      },
    });
  });

  return calls;
}
