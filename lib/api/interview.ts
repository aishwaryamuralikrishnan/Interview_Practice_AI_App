/**
 * The interview's three endpoints, kept free of Next.js like lib/api/job.ts:
 *
 *   POST /api/question  → the next question, one at a time
 *   POST /api/evaluate  → score one answer
 *   POST /api/summary   → the closing verdict
 *
 * The browser holds the interview between calls and sends back what each call
 * needs; lib/api/validate.ts rebuilds it from that untrusted JSON first.
 *
 * Evaluation is one call per request rather than one request for the whole
 * transcript. The Python scored every answer in one blocking loop behind a
 * progress bar; here that loop runs in the browser, so the progress is real,
 * no single request runs for minutes, and a timeout costs one answer, not all.
 */

import { buildOverallSummary, evaluateTurn, failedEvaluation, type Evaluation, type OverallSummary } from "../evaluation";
import {
  answered,
  awaitingAnswer,
  buildQuestionPlan,
  isComplete,
  nextQuestion,
  type TurnRecord,
} from "../interview";
import { LLMError, type ChatClient, type ModelSettings, type Usage } from "../llm";
import { InputError, parseModelSettings } from "./settings";
import { parseInterviewSettings, parseJob, parseTranscript, parseTurn } from "./validate";

export type UsageJSON = ReturnType<Usage["toJSON"]>;

export type Failure = { ok: false; stage: "input" | "config" | "model" | "state"; error: string };

export type QuestionResponse = { ok: true; turn: TurnRecord; usage: UsageJSON } | Failure;
export type EvaluateResponse = { ok: true; evaluation: Evaluation; usage: UsageJSON } | Failure;
export type SummaryResponse = { ok: true; summary: OverallSummary; usage: UsageJSON } | Failure;

export interface InterviewDeps {
  makeClient: (settings: ModelSettings) => ChatClient & { usage: Usage };
}

interface Result<T> {
  status: number;
  body: T | Failure;
}

const fail = (status: number, stage: Failure["stage"], error: string): Result<never> => ({
  status,
  body: { ok: false, stage, error },
});

/** The request is well-formed but asks for something the interview's state rules out. */
class StateError extends Error {}

/** Validate, build a client, run — mapping each kind of failure to its status. */
async function run<P extends { settings: ModelSettings }, T>(
  input: unknown,
  deps: InterviewDeps,
  parse: (req: Record<string, unknown>) => P,
  work: (client: ChatClient & { usage: Usage }, parsed: P) => Promise<T>,
): Promise<Result<T>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return fail(400, "input", "The request body must be a JSON object.");
  }

  let parsed: P;
  try {
    parsed = parse(input as Record<string, unknown>);
  } catch (exc) {
    if (exc instanceof InputError) return fail(400, "input", exc.message);
    if (exc instanceof StateError) return fail(409, "state", exc.message);
    throw exc;
  }

  let client: ChatClient & { usage: Usage };
  try {
    client = deps.makeClient(parsed.settings);
  } catch (exc) {
    if (exc instanceof LLMError) return fail(500, "config", exc.message);
    throw exc;
  }

  try {
    return { status: 200, body: await work(client, parsed) };
  } catch (exc) {
    if (exc instanceof LLMError) return fail(502, "model", exc.message);
    throw exc;
  }
}

function common(req: Record<string, unknown>) {
  return {
    settings: parseModelSettings(req.settings),
    job: parseJob(req.job),
    interview: parseInterviewSettings(req.interview),
  };
}

// ---------------------------------------------------------------------------

export function handleQuestionRequest(input: unknown, deps: InterviewDeps): Promise<Result<QuestionResponse>> {
  return run(
    input,
    deps,
    (req) => {
      const base = common(req);
      const plan = buildQuestionPlan(base.interview);
      const transcript = parseTranscript(req.transcript, plan);
      if (transcript.length >= plan.length) throw new StateError("The interview already has all of its questions.");
      if (awaitingAnswer(transcript)) throw new StateError("The latest question has not been answered yet.");
      return { ...base, transcript };
    },
    async (client, p) => {
      const { job, interview, transcript } = p;
      const turn = await nextQuestion(client, job, interview, transcript);
      return { ok: true as const, turn, usage: client.usage.toJSON() };
    },
  );
}

export function handleEvaluateRequest(input: unknown, deps: InterviewDeps): Promise<Result<EvaluateResponse>> {
  return run(
    input,
    deps,
    (req) => {
      const base = common(req);
      const turn = parseTurn(req.turn);
      if (!answered(turn)) throw new StateError("That question has not been answered, so it cannot be scored.");
      return { ...base, turn };
    },
    async (client, p) => {
      const { job, interview, turn } = p;
      // As evaluate_all does: a failed call becomes a placeholder evaluation,
      // so one bad answer does not lose the whole report.
      let evaluation: Evaluation;
      try {
        evaluation = await evaluateTurn(client, job, turn, interview);
      } catch (exc) {
        if (!(exc instanceof LLMError)) throw exc;
        evaluation = failedEvaluation(turn, exc.message);
      }
      return { ok: true as const, evaluation, usage: client.usage.toJSON() };
    },
  );
}

export function handleSummaryRequest(input: unknown, deps: InterviewDeps): Promise<Result<SummaryResponse>> {
  return run(
    input,
    deps,
    (req) => {
      const base = common(req);
      const transcript = parseTranscript(req.transcript, buildQuestionPlan(base.interview));
      if (!isComplete(transcript, base.interview)) throw new StateError("The interview is not finished yet.");
      if (transcript.some((t) => t.evaluation === null)) throw new StateError("Every answer must be scored first.");
      return { ...base, transcript };
    },
    async (client, p) => {
      const { job, interview, transcript } = p;
      // build_overall_summary already turns an LLMError into an error summary.
      const summary = await buildOverallSummary(client, job, transcript, interview);
      return { ok: true as const, summary, usage: client.usage.toJSON() };
    },
  );
}
