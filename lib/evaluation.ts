/**
 * evaluation.ts — steps 8–9: critique, score and rewrite every answer.
 *
 * Each answer is scored independently against the rubric for its question
 * type (config.RUBRICS), so the criteria the user sees on the radar chart and
 * the criteria the model is asked for are always the same list.
 *
 * Nothing the model returns is trusted as-is: scores are matched back to the
 * rubric and clamped, text fields are collapsed or capped, and `overall` is
 * computed here rather than asked for — the headline number under each answer
 * is arithmetic, not a claim.
 *
 * Ported from evaluation.py.
 */

import * as config from "./config";
import type { QuestionType, ScoreBand } from "./config";
import { interviewSettingsAsDict, typeLabel, type InterviewSettings, type TurnRecord } from "./interview";
import { LLMError, settingsAsDict, type ChatClient, type ChatMessage, type JsonObject, type ModelSettings } from "./llm";
import * as prompts from "./prompts";
import {
  isPyDigit,
  isPySpace,
  isPyUpper,
  pyCollapse,
  pyFloat,
  pyFormat,
  pyMean,
  pyOr,
  pyRound,
  pyRoundInt,
  pyRstripChars,
  pyStr,
  pyStrip,
} from "./py";
import { toPromptText, type JobDescription } from "./job";

export interface Evaluation {
  question_type: QuestionType;
  criteria: string[];
  scores: Record<string, number>;
  overall: number;
  /** Not shown per answer — it feeds the closing summary. */
  strength: string;
  suggested_improvement: string;
  improved_answer: string;
  error: string | null;
}

export function clampScore(value: unknown): number {
  const f = pyFloat(value);
  if (f === null || !Number.isFinite(f)) return 0;
  return Math.max(0, Math.min(config.SCORE_MAX, pyRoundInt(f)));
}

/** Collapse whatever came back into a single line of text. */
export function oneLine(value: unknown): string {
  return pyCollapse(pyStr(pyOr(value, "")));
}

// Tokens that end in a full stop without ending a sentence. Both languages the
// app supports, because a German interview is full of "z. B." and "d. h.".
const ABBREVIATIONS = new Set([
  // English
  "e.g.", "i.e.", "etc.", "vs.", "cf.", "al.", "approx.", "est.", "no.",
  "fig.", "eq.", "min.", "max.", "dr.", "prof.", "mr.", "mrs.", "ms.",
  "st.", "inc.", "ltd.", "co.", "jr.", "sr.",
  // German
  "z.b.", "u.a.", "d.h.", "bzw.", "ca.", "usw.", "ggf.", "inkl.", "evtl.",
  "nr.", "abs.", "bspw.", "vgl.", "ff.", "mio.", "mrd.", "std.", "dt.",
]);

const TRAILING_TOKEN = /[A-Za-zÄÖÜäöüß.]+$/;
const SENTENCE_START = "\"‘“'([{";
const CLOSERS = "\"”’')]";

/**
 * Is the "." at `stop` really the end of a sentence? `resume` is the index of
 * the next non-space character.
 */
function isSentenceEnd(text: string, stop: number, resume: number): boolean {
  const token = TRAILING_TOKEN.exec(text.slice(0, stop + 1));
  if (token) {
    const word = token[0].toLowerCase();
    if (ABBREVIATIONS.has(word)) return false;
    // A lone letter before the stop is an initial or half an abbreviation
    // written with a space — "z. B.", "u. a.", "A. Schmidt".
    const bare = pyRstripChars(word, ".");
    if (bare.length === 1) return false;
  }

  if (resume >= text.length) return true;
  const next = String.fromCodePoint(text.codePointAt(resume)!);
  // A new sentence opens with a capital, a digit, or an opening quote.
  // Anything else is a continuation, and merging is safer than cutting.
  return isPyUpper(next) || isPyDigit(next) || SENTENCE_START.includes(next);
}

/**
 * Split prose into sentences without being fooled by abbreviations.
 *
 * The naive "split on [.!?] followed by whitespace" breaks on the very
 * placeholders the evaluation prompt asks for — "[e.g. 3 engineers]" — and
 * truncated a rewritten answer mid-bracket. This never splits inside a
 * bracket, never after a known abbreviation, and errs towards keeping text
 * together: under-splitting shows a slightly longer answer, over-splitting
 * shows a mangled one.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let depth = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    } else if ((char === "." || char === "!" || char === "?") && depth === 0) {
      let end = index + 1;
      while (end < text.length && CLOSERS.includes(text[end])) end += 1;
      let resume = end;
      while (resume < text.length && isPySpace(text[resume])) resume += 1;
      if (resume > end && isSentenceEnd(text, index, resume)) {
        const chunk = pyStrip(text.slice(start, end));
        if (chunk) sentences.push(chunk);
        start = resume;
        index = resume;
        continue;
      }
    }
    index += 1;
  }

  const tail = pyStrip(text.slice(start));
  if (tail) sentences.push(tail);
  return sentences;
}

/** Hard-cap prose at `limit` sentences. The prompt asks for three; this makes it true. */
export function limitSentences(value: unknown, limit: number): string {
  const text = pyCollapse(pyStr(pyOr(value, "")));
  if (!text) return "";
  return pyStrip(splitSentences(text).slice(0, limit).join(" "));
}

export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => pyStrip(pyStr(item))).filter((s) => s !== "");
  if (typeof value === "string" && pyStrip(value)) return [pyStrip(value)];
  return [];
}

export function evaluationMessages(
  job: JobDescription,
  turn: TurnRecord,
  settings: InterviewSettings,
  useAnchors: boolean = config.USE_EVALUATION_ANCHORS,
): ChatMessage[] {
  const system = pyFormat(prompts.EVALUATION_SYSTEM, {
    score_max: config.SCORE_MAX,
    language_name: settings.language,
    calibration_block: prompts.calibrationBlock(turn.question_type, useAnchors),
  });
  const user = pyFormat(prompts.EVALUATION_USER, {
    job_description: toPromptText(job),
    question_type_label: typeLabel(turn),
    rubric_block: prompts.rubricBlock(turn.question_type),
    question: turn.question,
    answer: turn.answer || "(the candidate gave no answer)",
    score_max: config.SCORE_MAX,
    criteria_json_keys: prompts.criteriaJsonKeys(turn.question_type),
  });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Score and critique one answer. Always returns a well-formed object. */
export async function evaluateTurn(
  client: ChatClient,
  job: JobDescription,
  turn: TurnRecord,
  settings: InterviewSettings,
): Promise<Evaluation> {
  const criteria = Object.keys(config.RUBRICS[turn.question_type]);
  const data = await client.chatJson(evaluationMessages(job, turn, settings), "evaluation");

  let rawScores = data.scores;
  if (rawScores === null || typeof rawScores !== "object" || Array.isArray(rawScores)) rawScores = {};

  // Match the model's keys back to our criteria case-insensitively, so a
  // reply of "technical knowledge" still lands on "Technical Knowledge".
  const lookup = new Map<string, unknown>();
  for (const [key, value] of Object.entries(rawScores as JsonObject)) {
    lookup.set(pyStrip(key).toLowerCase(), value);
  }
  const scores: Record<string, number> = {};
  for (const name of criteria) scores[name] = clampScore(lookup.get(name.toLowerCase()));

  return {
    question_type: turn.question_type,
    criteria,
    scores,
    overall: pyRound(pyMean(Object.values(scores)), 2),
    strength: oneLine(data.strength),
    suggested_improvement: oneLine(data.suggested_improvement),
    improved_answer: limitSentences(data.improved_answer, config.MAX_IMPROVED_ANSWER_SENTENCES),
    error: null,
  };
}

/** Placeholder so one failed call doesn't lose the whole report. */
export function failedEvaluation(turn: TurnRecord, message: string): Evaluation {
  const criteria = Object.keys(config.RUBRICS[turn.question_type]);
  return {
    question_type: turn.question_type,
    criteria,
    scores: Object.fromEntries(criteria.map((name) => [name, 0])),
    overall: 0.0,
    strength: "",
    suggested_improvement: "",
    improved_answer: "",
    error: message,
  };
}

/**
 * Evaluate every turn that has no evaluation yet. Sequential, as in the
 * Python — one call at a time keeps well inside rate limits. Returns a new
 * transcript.
 */
export async function evaluateAll(
  client: ChatClient,
  job: JobDescription,
  transcript: TurnRecord[],
  settings: InterviewSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<TurnRecord[]> {
  const total = transcript.length;
  const out: TurnRecord[] = [];
  for (let i = 0; i < transcript.length; i++) {
    let turn = transcript[i];
    if (turn.evaluation === null || turn.evaluation === undefined) {
      try {
        turn = { ...turn, evaluation: await evaluateTurn(client, job, turn, settings) };
      } catch (exc) {
        if (!(exc instanceof LLMError)) throw exc;
        turn = { ...turn, evaluation: failedEvaluation(turn, exc.message) };
      }
    }
    out.push(turn);
    onProgress?.(i + 1, total);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation for the charts
// ---------------------------------------------------------------------------

export function scoredTurns(transcript: TurnRecord[]): TurnRecord[] {
  return transcript.filter((turn) => turn.evaluation && !turn.evaluation.error);
}

/** Mean score across all successfully evaluated answers, out of SCORE_MAX. */
export function overallScore(transcript: TurnRecord[]): number {
  const turns = scoredTurns(transcript);
  if (turns.length === 0) return 0.0;
  return pyRound(pyMean(turns.map((t) => t.evaluation!.overall)), 2);
}

/** {question_type: {criterion: average score}} — the radar chart data. */
export function categoryAverages(transcript: TurnRecord[]): Partial<Record<QuestionType, Record<string, number>>> {
  const result: Partial<Record<QuestionType, Record<string, number>>> = {};
  for (const [questionType, rubric] of Object.entries(config.RUBRICS) as [QuestionType, Record<string, string>][]) {
    const turns = scoredTurns(transcript).filter((t) => t.question_type === questionType);
    if (turns.length === 0) continue;
    const averages: Record<string, number> = {};
    for (const criterion of Object.keys(rubric)) {
      averages[criterion] = pyRound(pyMean(turns.map((t) => t.evaluation!.scores[criterion] ?? 0)), 2);
    }
    result[questionType] = averages;
  }
  return result;
}

/** {question_type: mean overall score} — for the summary tiles. */
export function categoryOverall(transcript: TurnRecord[]): Partial<Record<QuestionType, number>> {
  const result: Partial<Record<QuestionType, number>> = {};
  for (const questionType of Object.keys(config.RUBRICS) as QuestionType[]) {
    const turns = scoredTurns(transcript).filter((t) => t.question_type === questionType);
    if (turns.length) result[questionType] = pyRound(pyMean(turns.map((t) => t.evaluation!.overall)), 2);
  }
  return result;
}

export interface QuestionRow {
  number: number;
  label: string;
  question_type: QuestionType;
  type_label: string;
  score: number;
  question: string;
}

/** Flat rows for the per-question bar chart. */
export function perQuestionRows(transcript: TurnRecord[]): QuestionRow[] {
  return transcript
    .filter((turn) => turn.evaluation)
    .map((turn) => ({
      number: turn.number,
      label: `Q${turn.number}`,
      question_type: turn.question_type,
      type_label: typeLabel(turn),
      score: turn.evaluation!.overall,
      question: turn.question,
    }));
}

/**
 * How Python's f-string prints `overall`: an int when the mean came out
 * whole, a float otherwise — except a failed evaluation, whose 0.0 is a float
 * literal and prints as "0.0".
 */
function formatOverall(evaluation: Evaluation | null): string {
  if (!evaluation) return "0";
  if (evaluation.error !== null && evaluation.error !== undefined && evaluation.overall === 0) return "0.0";
  return pyStr(evaluation.overall);
}

/** Compact text of all results, fed to the overall-summary prompt. */
export function buildResultsDigest(transcript: TurnRecord[]): string {
  const blocks = transcript.map((turn) => {
    const evaluation = turn.evaluation;
    const scores = Object.entries(evaluation?.scores ?? {})
      .map(([name, value]) => `${name} ${pyStr(value)}/${config.SCORE_MAX}`)
      .join(", ");
    return (
      `Q${turn.number} [${typeLabel(turn)}] — overall ` +
      `${formatOverall(evaluation)}/${config.SCORE_MAX} (${scores})\n` +
      `  Question: ${turn.question}\n` +
      `  What worked: ${evaluation?.strength ?? ""}\n` +
      `  Needs improving: ${evaluation?.suggested_improvement ?? ""}`
    );
  });
  return blocks.join("\n\n");
}

export interface OverallSummary {
  headline: string;
  readiness: string;
  what_worked: string[];
  suggested_improvements: string[];
  closing_advice: string;
  error: string | null;
}

export function overallSummaryMessages(
  job: JobDescription,
  transcript: TurnRecord[],
  settings: InterviewSettings,
): ChatMessage[] {
  return [
    { role: "system", content: pyFormat(prompts.OVERALL_SUMMARY_SYSTEM, { language_name: settings.language }) },
    {
      role: "user",
      content: pyFormat(prompts.OVERALL_SUMMARY_USER, {
        job_description: toPromptText(job),
        results_digest: buildResultsDigest(transcript),
        total_questions: transcript.length,
      }),
    },
  ];
}

/** The closing verdict shown above the charts. */
export async function buildOverallSummary(
  client: ChatClient,
  job: JobDescription,
  transcript: TurnRecord[],
  settings: InterviewSettings,
): Promise<OverallSummary> {
  let data: JsonObject;
  try {
    data = await client.chatJson(overallSummaryMessages(job, transcript, settings), "evaluation");
  } catch (exc) {
    if (!(exc instanceof LLMError)) throw exc;
    return {
      headline: "",
      readiness: "",
      what_worked: [],
      suggested_improvements: [],
      closing_advice: "",
      error: exc.message,
    };
  }

  const oneSentence = (items: string[]) =>
    items.map((item) => limitSentences(item, 1)).slice(0, config.MAX_SUMMARY_POINTS);

  return {
    headline: oneLine(data.headline),
    readiness: oneLine(data.readiness),
    what_worked: oneSentence(asStringList(data.what_worked)),
    suggested_improvements: oneSentence(asStringList(data.suggested_improvements)),
    closing_advice: pyStrip(pyStr(pyOr(data.closing_advice, ""))),
    error: null,
  };
}

export function scoreBand(score: number): ScoreBand {
  if (score >= 8) return "strong";
  if (score >= 5) return "ok";
  return "weak";
}

export function scoreColor(score: number): string {
  return config.SCORE_BAND_COLORS[scoreBand(score)];
}

/** Everything needed to reconstruct the report, for the download button. */
export function transcriptToExport(
  transcript: TurnRecord[],
  job: JobDescription,
  settings: InterviewSettings,
  summary: OverallSummary | Record<string, unknown> | null = null,
  modelSettings: ModelSettings | null = null,
) {
  return {
    job: { title: job.job_title, company: job.company, location: job.location, source_url: job.source_url },
    settings: interviewSettingsAsDict(settings),
    model: modelSettings ? settingsAsDict(modelSettings) : null,
    overall_score: overallScore(transcript),
    score_max: config.SCORE_MAX,
    category_overall: categoryOverall(transcript),
    category_averages: categoryAverages(transcript),
    summary: summary && Object.keys(summary).length ? summary : {},
    questions: transcript.map((turn) => ({
      number: turn.number,
      type: turn.question_type,
      question: turn.question,
      answer: turn.answer,
      evaluation: turn.evaluation,
    })),
  };
}

