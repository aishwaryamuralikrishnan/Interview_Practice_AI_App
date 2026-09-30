/**
 * POST /api/question, /api/evaluate and /api/summary — through their handlers
 * with a scripted model, plus the routes for body parsing and the missing key.
 */

import { describe, expect, it } from "vitest";

import * as config from "@/lib/config";
import { handleEvaluateRequest, handleQuestionRequest, handleSummaryRequest } from "@/lib/api/interview";
import { parseEvaluation } from "@/lib/api/validate";
import { defaultInterviewSettings, type TurnRecord } from "@/lib/interview";
import { LLMClient } from "@/lib/llm";
import { emptyJob } from "@/lib/scraper";
import { StubClient } from "./helpers";

const job = emptyJob({ job_title: "Data Engineer", company: "Acme", summary: "Pipelines.", requirements: ["SQL"] });
const interview = defaultInterviewSettings({ num_questions: 3, language: "German" }); // intro, technical, behavioural

function deps(replies: unknown[]) {
  const clients: StubClient[] = [];
  return {
    clients,
    deps: {
      makeClient: () => {
        const c = new StubClient(replies);
        clients.push(c);
        return c;
      },
    },
  };
}

const noKey = { makeClient: () => new LLMClient({ apiKey: "" }) };

const scores = (type: config.QuestionType, value: unknown) =>
  Object.fromEntries(Object.keys(config.RUBRICS[type]).map((c) => [c, value]));

function evaluationFor(type: config.QuestionType, value = 7) {
  return parseEvaluation({ scores: scores(type, value), strength: "Clear.", suggested_improvement: "Quantify." }, type, "e");
}

const TYPES: config.QuestionType[] = ["intro", "technical", "behavioural"];

function turns(count: number, { answered = true, scored = false } = {}): TurnRecord[] {
  return TYPES.slice(0, count).map((type, i) => ({
    number: i + 1,
    question_type: type,
    question: `Question ${i + 1}?`,
    answer: answered ? `Answer ${i + 1}.` : null,
    evaluation: scored ? evaluationFor(type) : null,
  }));
}

// ---------------------------------------------------------------------------
describe("POST /api/question", () => {
  it("asks the first question with the chosen interview settings", async () => {
    const d = deps(["Question: Stellen Sie sich bitte vor."]);
    const { status, body } = await handleQuestionRequest({ job, interview, transcript: [] }, d.deps);
    expect(status).toBe(200);
    if (!body.ok) throw new Error(JSON.stringify(body));
    expect(body.turn).toEqual({
      number: 1,
      question_type: "intro",
      question: "Stellen Sie sich bitte vor.", // label stripped by tidyQuestion
      answer: null,
      evaluation: null,
    });
    const sent = d.clients[0].sent[0];
    expect(sent.profile).toBe("question_generation");
    expect(sent.messages[0].content).toContain("Data Engineer");
    expect(sent.messages[0].content).toContain("German");
  });

  it("replays the conversation so far, and picks the planned type", async () => {
    const d = deps(["Next one."]);
    const { body } = await handleQuestionRequest({ job, interview, transcript: turns(1) }, d.deps);
    expect(body.ok && body.turn.question_type).toBe("technical");
    const roles = d.clients[0].sent[0].messages.map((m) => m.role);
    expect(roles).toEqual(["system", "assistant", "user", "user"]);
  });

  it("refuses while a question is still unanswered, or once all are asked", async () => {
    for (const transcript of [turns(1, { answered: false }), turns(3)]) {
      const d = deps(["never sent"]);
      const { status, body } = await handleQuestionRequest({ job, interview, transcript }, d.deps);
      expect(status).toBe(409);
      expect(body).toMatchObject({ ok: false, stage: "state" });
      expect(d.clients).toHaveLength(0);
    }
  });

  it("rejects a transcript this app could not have produced", async () => {
    const wrongType = [{ ...turns(1)[0], question_type: "technical" }];
    const wrongNumber = [{ ...turns(1)[0], number: 2 }];
    const hugeAnswer = [{ ...turns(1)[0], answer: "x".repeat(20_001) }];
    for (const transcript of [wrongType, wrongNumber, hugeAnswer, "not a list", [null]]) {
      const { status, body } = await handleQuestionRequest({ job, interview, transcript }, deps([]).deps);
      expect(status, JSON.stringify(transcript).slice(0, 60)).toBe(400);
      expect(body).toMatchObject({ ok: false, stage: "input" });
    }
  });

  it("rejects bad interview settings and a bad job", async () => {
    for (const bad of [
      { interview: { ...interview, num_questions: 99 } },
      { interview: { ...interview, attitude: "Hostile" } },
      { interview: { ...interview, num_questions: 4.5 } },
      { job: { ...job, requirements: "SQL" } },
      { job: { ...job, job_title: 5 } },
      { job: "a job" },
    ]) {
      const { status } = await handleQuestionRequest({ job, interview, transcript: [], ...bad }, deps([]).deps);
      expect(status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("maps a model failure to 502 and a missing key to 500", async () => {
    const failed = await handleQuestionRequest({ job, interview, transcript: [] }, deps([{ __raise__: "Timed out." }]).deps);
    expect(failed).toEqual({ status: 502, body: { ok: false, stage: "model", error: "Timed out." } });
    const missing = await handleQuestionRequest({ job, interview, transcript: [] }, noKey);
    expect(missing.status).toBe(500);
    expect(missing.body).toMatchObject({ ok: false, stage: "config" });
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/evaluate", () => {
  const turn = turns(2)[1]; // technical

  it("scores one answer against its own rubric", async () => {
    const d = deps([{ scores: scores("technical", 8), strength: "Solid.", suggested_improvement: "Name a metric.", improved_answer: "Better." }]);
    const { status, body } = await handleEvaluateRequest({ job, interview, turn }, d.deps);
    expect(status).toBe(200);
    if (!body.ok) throw new Error(JSON.stringify(body));
    expect(body.evaluation.criteria).toEqual(Object.keys(config.RUBRICS.technical));
    expect(body.evaluation.overall).toBe(8);
    expect(body.evaluation.error).toBeNull();
    expect(d.clients[0].sent[0].profile).toBe("evaluation");
  });

  it("turns a model failure into a placeholder, as evaluate_all does", async () => {
    const { status, body } = await handleEvaluateRequest({ job, interview, turn }, deps([{ __raise__: "Rate limited." }]).deps);
    expect(status).toBe(200);
    expect(body.ok && body.evaluation).toMatchObject({ overall: 0, error: "Rate limited." });
  });

  it("refuses an unanswered question", async () => {
    const { status } = await handleEvaluateRequest({ job, interview, turn: { ...turn, answer: "  " } }, deps([]).deps);
    expect(status).toBe(409);
  });

  it("needs a key", async () => {
    expect((await handleEvaluateRequest({ job, interview, turn }, noKey)).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/summary", () => {
  const reply = {
    headline: "Promising.",
    readiness: "Getting there",
    what_worked: ["Clear structure. Good pace too.", "Honest."],
    suggested_improvements: ["D."],
    closing_advice: "Practise.",
  };

  it("summarises a finished, scored interview", async () => {
    const d = deps([reply]);
    const { status, body } = await handleSummaryRequest({ job, interview, transcript: turns(3, { scored: true }) }, d.deps);
    expect(status).toBe(200);
    if (!body.ok) throw new Error(JSON.stringify(body));
    expect(body.summary.what_worked).toEqual(["Clear structure.", "Honest."]); // one sentence each
    expect(d.clients[0].sent[0].messages[1].content).toContain("RESULTS OF ALL");
  });

  it("refuses an unfinished or unscored interview", async () => {
    for (const transcript of [turns(2, { scored: true }), turns(3)]) {
      const { status } = await handleSummaryRequest({ job, interview, transcript }, deps([reply]).deps);
      expect(status).toBe(409);
    }
  });

  it("returns an error summary rather than failing when the model does", async () => {
    const { status, body } = await handleSummaryRequest(
      { job, interview, transcript: turns(3, { scored: true }) },
      deps([{ __raise__: "Down." }]).deps,
    );
    expect(status).toBe(200);
    expect(body.ok && body.summary.error).toBe("Down.");
  });

  it("never trusts scores sent back by the browser", async () => {
    const d = deps([reply]);
    const forged = turns(3, { scored: true }).map((t) => ({
      ...t,
      evaluation: { ...t.evaluation, scores: scores(t.question_type, 99), overall: 42, criteria: ["Charm"] },
    }));
    await handleSummaryRequest({ job, interview, transcript: forged }, d.deps);
    const digest = d.clients[0].sent[0].messages[1].content;
    expect(digest).toContain(`overall 10/${config.SCORE_MAX}`);
    expect(digest).not.toContain("42");
    expect(digest).not.toContain("Charm");
  });
});

// ---------------------------------------------------------------------------
describe("parseEvaluation", () => {
  it("rebuilds criteria, clamps scores and recomputes overall", () => {
    const e = parseEvaluation({ scores: { Situation: 12, Task: "6.5", Action: -3 }, overall: 9 }, "behavioural", "e")!;
    expect(e.criteria).toEqual(["Situation", "Task", "Action", "Result"]);
    expect(e.scores).toEqual({ Situation: 10, Task: 6, Action: 0, Result: 0 }); // 6.5 → 6, as Python rounds
    expect(e.overall).toBe(4);
  });

  it("keeps a failed evaluation failed", () => {
    expect(parseEvaluation({ error: "Down.", scores: scores("intro", 9) }, "intro", "e")).toMatchObject({ overall: 0, error: "Down." });
  });
});

// ---------------------------------------------------------------------------
describe("the routes", () => {
  const routes = {
    question: () => import("@/app/api/question/route"),
    evaluate: () => import("@/app/api/evaluate/route"),
    summary: () => import("@/app/api/summary/route"),
  };

  it.each(Object.keys(routes) as (keyof typeof routes)[])("/api/%s rejects a body that isn't JSON", async (name) => {
    const { POST } = await routes[name]();
    const response: Response = await POST(new Request(`http://localhost/api/${name}`, { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
  });

  it("/api/question answers a missing key with a 500", async () => {
    const saved = process.env[config.API_KEY_ENV_VAR];
    delete process.env[config.API_KEY_ENV_VAR];
    try {
      const { POST } = await import("@/app/api/question/route");
      const response: Response = await POST(
        new Request("http://localhost/api/question", { method: "POST", body: JSON.stringify({ job, interview, transcript: [] }) }),
      );
      expect(response.status).toBe(500);
    } finally {
      if (saved !== undefined) process.env[config.API_KEY_ENV_VAR] = saved;
    }
  });
});
