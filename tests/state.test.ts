/** The session reducer: the UI's state machine, without rendering anything. */

import { describe, expect, it } from "vitest";

import { initialState, reducer, type AppState } from "@/lib/client/state";
import { defaultInterviewSettings, type TurnRecord } from "@/lib/interview";
import { defaultModelSettings } from "@/lib/llm";
import { emptyJob } from "@/lib/job";
import { EMPTY_USAGE } from "@/lib/client/api";

const usage = { ...EMPTY_USAGE, calls: 1, total_tokens: 100, peak_completion_tokens: 60 };
const plan = { key_skills: ["SQL"], interview_topics: [], study_plan: [] };
const turn = (number: number, answer: string | null = null): TurnRecord => ({
  number,
  question_type: number === 1 ? "intro" : "technical",
  question: `Q${number}?`,
  answer,
  evaluation: null,
});

function interviewing(): AppState {
  let s = reducer(initialState(), { type: "jobLoaded", job: emptyJob({ job_title: "X" }), plan, usage });
  s = reducer(s, { type: "beginInterview", interview: defaultInterviewSettings({ num_questions: 3 }) });
  return s;
}

describe("the session reducer", () => {
  it("moves through the stages", () => {
    const s = interviewing();
    expect(s.stage).toBe("interview");
    expect(s.usage.calls).toBe(1);
    expect(s.transcript).toEqual([]);
  });

  it("appends a question only if it is the next one", () => {
    let s = reducer(interviewing(), { type: "questionAsked", turn: turn(1), usage });
    expect(s.transcript).toHaveLength(1);
    // A late or duplicated reply is ignored rather than corrupting the order.
    s = reducer(s, { type: "questionAsked", turn: turn(1), usage });
    s = reducer(s, { type: "questionAsked", turn: turn(3), usage });
    expect(s.transcript).toHaveLength(1);
    expect(s.usage.calls).toBe(2);
  });

  it("records the answer on the waiting question", () => {
    let s = reducer(interviewing(), { type: "questionAsked", turn: turn(1), usage });
    s = reducer(s, { type: "answered", answer: "  My answer.  " });
    expect(s.transcript[0].answer).toBe("My answer.");
  });

  it("ignores a question that arrives after the interview was abandoned", () => {
    let s = reducer(interviewing(), { type: "abandonInterview" });
    expect(s.stage).toBe("job_review");
    expect(s.plan).toEqual(plan); // the plan survives
    s = reducer(s, { type: "questionAsked", turn: turn(1), usage });
    expect(s.transcript).toEqual([]);
  });

  it("sums usage and keeps the largest single response", () => {
    let s = reducer(interviewing(), { type: "usage", usage: { ...usage, peak_completion_tokens: 900 } });
    s = reducer(s, { type: "usage", usage: { ...usage, peak_completion_tokens: 300 } });
    expect(s.usage.calls).toBe(3);
    expect(s.usage.total_tokens).toBe(300);
    expect(s.usage.peak_completion_tokens).toBe(900);
  });

  it("practising again keeps the role and the last settings; starting over keeps only the model", () => {
    let s = reducer(interviewing(), { type: "setModelSettings", settings: defaultModelSettings({ model: "openai/gpt-5" }) });
    const again = reducer(s, { type: "practiseAgain" });
    expect(again.stage).toBe("interview_setup");
    expect(again.job).not.toBeNull();
    expect(again.interview?.num_questions).toBe(3);

    s = reducer(s, { type: "startOver" });
    expect(s).toEqual({ ...initialState(), modelSettings: defaultModelSettings({ model: "openai/gpt-5" }) });
  });
});
