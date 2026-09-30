/**
 * Rebuild the app's data types from untrusted JSON sent by the browser.
 *
 * In Streamlit the job, the transcript and the scores never left the server
 * process. Here the browser holds them between requests and sends them back,
 * so every field is checked for type and size before it reaches a prompt.
 * Two reasons:
 *
 *  - a malformed body must fail as a clear 400, not as a crash deep inside
 *    prompt assembly;
 *  - a size cap on every string bounds what one request can cost, however it
 *    was crafted.
 *
 * Nothing here trusts a value it can recompute: an evaluation's criteria come
 * from config.RUBRICS and its overall is re-averaged from the clamped scores.
 */

import * as config from "../config";
import { clampScore, type Evaluation, type OverallSummary } from "../evaluation";
import type { InterviewSettings, TurnRecord } from "../interview";
import { cpLen, pyMean, pyRound } from "../py";
import type { JobDescription } from "../job";
import { InputError } from "./settings";

// Generous enough that no real posting or answer is refused.
export const LIMITS = {
  shortText: 1_000, // title, company, location…
  mediumText: 20_000, // summary, original description
  listItems: 100,
  listItemText: 2_000,
  question: 5_000,
  answer: 20_000,
  feedback: 10_000,
} as const;

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function record(value: unknown, name: string): Rec {
  if (!isRecord(value)) throw new InputError(`${name} must be an object`);
  return value;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new InputError(`${name} must be a string`);
  if (cpLen(value) > max) throw new InputError(`${name} is longer than ${max} characters`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return text(value, name, max);
}

function textOr(value: unknown, name: string, max: number, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return text(value, name, max);
}

function list(value: unknown, name: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new InputError(`${name} must be a list`);
  if (value.length > LIMITS.listItems) throw new InputError(`${name} has more than ${LIMITS.listItems} items`);
  return value.map((item, i) => text(item, `${name}[${i}]`, LIMITS.listItemText));
}

function oneOf<T extends string>(value: unknown, options: readonly T[], name: string): T {
  if (!(options as readonly unknown[]).includes(value)) {
    throw new InputError(`${name} must be one of: ${options.join(", ")}`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------

export function parseJob(input: unknown): JobDescription {
  const j = record(input, "job");
  const s = (key: string) => optionalText(j[key], `job.${key}`, LIMITS.shortText);
  return {
    raw_text: textOr(j.raw_text, "job.raw_text", config.MAX_JOB_TEXT_CHARS),
    source_url: textOr(j.source_url, "job.source_url", LIMITS.shortText * 4),
    is_job_posting: j.is_job_posting !== false,
    extraction_note: s("extraction_note"),
    injection_notice: optionalText(j.injection_notice, "job.injection_notice", LIMITS.mediumText),
    job_title: s("job_title"),
    company: s("company"),
    location: s("location"),
    employment_type: s("employment_type"),
    seniority: s("seniority"),
    language_of_posting: s("language_of_posting"),
    was_translated: j.was_translated === true,
    summary: textOr(j.summary, "job.summary", LIMITS.mediumText),
    responsibilities: list(j.responsibilities, "job.responsibilities"),
    requirements: list(j.requirements, "job.requirements"),
    nice_to_have: list(j.nice_to_have, "job.nice_to_have"),
    tech_stack: list(j.tech_stack, "job.tech_stack"),
    benefits: list(j.benefits, "job.benefits"),
    original_description: textOr(j.original_description, "job.original_description", LIMITS.mediumText),
    original_responsibilities: list(j.original_responsibilities, "job.original_responsibilities"),
    original_requirements: list(j.original_requirements, "job.original_requirements"),
  };
}

export function parseInterviewSettings(input: unknown): InterviewSettings {
  const s = record(input, "interview");
  const n = s.num_questions;
  if (typeof n !== "number" || !Number.isInteger(n) || n < config.MIN_QUESTIONS || n > config.MAX_QUESTIONS) {
    throw new InputError(
      `interview.num_questions must be an integer from ${config.MIN_QUESTIONS} to ${config.MAX_QUESTIONS}`,
    );
  }
  return {
    language: oneOf(s.language, config.LANGUAGE_OPTIONS, "interview.language"),
    difficulty: oneOf(s.difficulty, config.DIFFICULTY_OPTIONS, "interview.difficulty"),
    attitude: oneOf(s.attitude, config.ATTITUDE_OPTIONS, "interview.attitude"),
    num_questions: n,
  };
}

/**
 * An evaluation as the browser sends it back. Criteria come from the rubric,
 * scores are clamped, overall is recomputed — so a forged or corrupted value
 * cannot reach the summary prompt in a shape the Python never produced.
 */
export function parseEvaluation(input: unknown, questionType: config.QuestionType, name: string): Evaluation | null {
  if (input === null || input === undefined) return null;
  const e = record(input, name);
  const criteria = Object.keys(config.RUBRICS[questionType]);
  const rawScores = isRecord(e.scores) ? e.scores : {};
  const error = optionalText(e.error, `${name}.error`, LIMITS.feedback);
  const scores = Object.fromEntries(criteria.map((c) => [c, error === null ? clampScore(rawScores[c]) : 0]));
  return {
    question_type: questionType,
    criteria,
    scores,
    overall: error === null ? pyRound(pyMean(Object.values(scores)), 2) : 0,
    strength: textOr(e.strength, `${name}.strength`, LIMITS.feedback),
    suggested_improvement: textOr(e.suggested_improvement, `${name}.suggested_improvement`, LIMITS.feedback),
    improved_answer: textOr(e.improved_answer, `${name}.improved_answer`, LIMITS.feedback),
    error,
  };
}

export function parseTurn(input: unknown, name = "turn"): TurnRecord {
  const t = record(input, name);
  const number = t.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > config.MAX_QUESTIONS) {
    throw new InputError(`${name}.number must be an integer from 1 to ${config.MAX_QUESTIONS}`);
  }
  const questionType = oneOf(t.question_type, config.QUESTION_TYPES, `${name}.question_type`);
  return {
    number,
    question_type: questionType,
    question: text(t.question, `${name}.question`, LIMITS.question),
    answer: optionalText(t.answer, `${name}.answer`, LIMITS.answer),
    evaluation: parseEvaluation(t.evaluation, questionType, `${name}.evaluation`),
  };
}

/**
 * A transcript must be the interview this settings object describes: turns
 * numbered 1…n in order, with the question type the plan assigns each slot.
 * Anything else was not produced by this app.
 */
export function parseTranscript(input: unknown, plan: config.QuestionType[]): TurnRecord[] {
  if (!Array.isArray(input)) throw new InputError("transcript must be a list");
  if (input.length > plan.length) throw new InputError("transcript has more turns than the interview has questions");
  return input.map((item, i) => {
    const turn = parseTurn(item, `transcript[${i}]`);
    if (turn.number !== i + 1) throw new InputError(`transcript[${i}].number must be ${i + 1}`);
    if (turn.question_type !== plan[i]) throw new InputError(`transcript[${i}] must be a ${plan[i]} question`);
    return turn;
  });
}

/** The closing summary as the browser sends it back, for the PDF report. */
export function parseSummary(input: unknown): OverallSummary | null {
  if (input === null || input === undefined) return null;
  const s = record(input, "summary");
  const items = (value: unknown, name: string) => {
    const got = list(value, name);
    if (got.length > 10) throw new InputError(`${name} has more than 10 items`);
    return got;
  };
  return {
    headline: textOr(s.headline, "summary.headline", LIMITS.feedback),
    readiness: textOr(s.readiness, "summary.readiness", LIMITS.shortText),
    what_worked: items(s.what_worked, "summary.what_worked"),
    suggested_improvements: items(s.suggested_improvements, "summary.suggested_improvements"),
    closing_advice: textOr(s.closing_advice, "summary.closing_advice", LIMITS.feedback),
    error: optionalText(s.error, "summary.error", LIMITS.feedback),
  };
}

/** An IANA time zone name the runtime recognises, e.g. "Europe/Berlin". */
export function parseTimeZone(input: unknown): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const zone = text(input, "timeZone", 64);
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    throw new InputError("timeZone must be an IANA time zone name");
  }
  return zone;
}
