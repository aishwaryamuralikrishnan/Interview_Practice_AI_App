/**
 * interview.ts — steps 5–7 of the workflow: the mock interview engine.
 *
 * The engine is deliberately stateless: the whole interview is a plan (a
 * fixed list of question types) plus a transcript (what has been asked and
 * answered so far). nextQuestion() takes both and produces exactly one more
 * question. The UI just stores those two things.
 *
 * Ported from interview.py.
 */

import * as config from "./config";
import type { Attitude, Difficulty, Language, QuestionType } from "./config";
import type { Evaluation } from "./evaluation";
import type { ChatClient, ChatMessage } from "./llm";
import * as prompts from "./prompts";
import { pyFormat, pyLstrip, pyStrip } from "./py";
import { toPromptText, type JobDescription } from "./job";

export interface QuestionCounts {
  intro: number;
  technical: number;
  behavioural: number;
}

/**
 * Divide `total` questions into one intro plus an even technical/behavioural
 * split, with the odd question going to technical.
 *
 *     3  -> 1 intro, 1 technical, 1 behavioural
 *     5  -> 1 intro, 2 technical, 2 behavioural
 *     6  -> 1 intro, 3 technical, 2 behavioural
 *     10 -> 1 intro, 5 technical, 4 behavioural
 */
export function splitQuestions(total: number | string): QuestionCounts {
  // Python int(): truncates a number toward zero; a string must be an integer
  // literal ("7" yes, "7.5" no).
  let asInt: number;
  if (typeof total === "string") {
    const t = pyStrip(total);
    if (!/^[+-]?\d(?:_?\d)*$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${total}'`);
    asInt = Number(t.replace(/_/g, ""));
  } else {
    asInt = Math.trunc(total);
  }
  const clamped = Math.max(config.MIN_QUESTIONS, Math.min(config.MAX_QUESTIONS, asInt));
  const remaining = clamped - config.NUM_INTRO_QUESTIONS;
  const technical = Math.floor((remaining + 1) / 2); // ties go to technical
  const behavioural = remaining - technical;
  return { intro: config.NUM_INTRO_QUESTIONS, technical, behavioural };
}

/**
 * The USER EXPERIENCE inputs collected in step 5.
 *
 * Deliberately separate from config.MODEL_PROFILES: nothing here changes how
 * the model is sampled, only what it is told to do.
 */
export interface InterviewSettings {
  language: Language;
  difficulty: Difficulty;
  attitude: Attitude;
  num_questions: number;
}

export function defaultInterviewSettings(overrides: Partial<InterviewSettings> = {}): InterviewSettings {
  return {
    language: config.DEFAULT_LANGUAGE,
    difficulty: config.DEFAULT_DIFFICULTY,
    attitude: config.DEFAULT_ATTITUDE,
    num_questions: config.DEFAULT_QUESTIONS,
    ...overrides,
  };
}

export function counts(settings: InterviewSettings): QuestionCounts {
  return splitQuestions(settings.num_questions);
}

export function totalQuestions(settings: InterviewSettings): number {
  const c = counts(settings);
  return c.intro + c.technical + c.behavioural;
}

export function interviewSettingsAsDict(settings: InterviewSettings) {
  return {
    language: settings.language,
    difficulty: settings.difficulty,
    attitude: settings.attitude,
    num_questions: totalQuestions(settings),
    counts: counts(settings),
  };
}

/** One question and the answer given to it. */
export interface TurnRecord {
  number: number; // 1-based position in the interview
  question_type: QuestionType;
  question: string;
  answer: string | null;
  evaluation: Evaluation | null;
}

export function typeLabel(turn: TurnRecord): string {
  return config.QUESTION_TYPE_LABELS[turn.question_type];
}

export function answered(turn: TurnRecord): boolean {
  return turn.answer !== null && turn.answer !== undefined && pyStrip(turn.answer) !== "";
}

/** The sequence of question types for this interview. */
export function buildQuestionPlan(settings: InterviewSettings): QuestionType[] {
  const c = counts(settings);
  return [
    ...Array<QuestionType>(c.intro).fill("intro"),
    ...Array<QuestionType>(c.technical).fill("technical"),
    ...Array<QuestionType>(c.behavioural).fill("behavioural"),
  ];
}

/** Assemble the interviewer persona from the user's runtime choices. */
export function buildSystemPrompt(job: JobDescription, settings: InterviewSettings): string {
  const c = counts(settings);
  return pyFormat(prompts.INTERVIEWER_SYSTEM, {
    language_instruction: prompts.LANGUAGE_INSTRUCTIONS[settings.language],
    difficulty_instruction: prompts.DIFFICULTY_INSTRUCTIONS[settings.difficulty],
    attitude_instruction: prompts.ATTITUDE_INSTRUCTIONS[settings.attitude],
    job_description: toPromptText(job),
    total_questions: totalQuestions(settings),
    num_technical: c.technical,
    num_behavioural: c.behavioural,
  });
}

/**
 * Replay the interview so far as alternating assistant/user messages. The
 * model sees its own earlier questions as its own turns — which is what lets
 * a follow-up build on what the candidate actually said.
 */
function transcriptMessages(transcript: TurnRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of transcript) {
    messages.push({ role: "assistant", content: turn.question });
    if (answered(turn)) messages.push({ role: "user", content: turn.answer as string });
  }
  return messages;
}

export function nextQuestionMessages(
  job: JobDescription,
  settings: InterviewSettings,
  transcript: TurnRecord[],
): { questionType: QuestionType; number: number; messages: ChatMessage[] } {
  const plan = buildQuestionPlan(settings);
  const number = transcript.length + 1;
  if (number > plan.length) throw new RangeError("The interview already has all of its questions.");

  const questionType = plan[number - 1];
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(job, settings) },
    ...transcriptMessages(transcript),
    {
      role: "user",
      content: pyFormat(prompts.NEXT_QUESTION_USER, {
        question_number: number,
        total_questions: totalQuestions(settings),
        question_type_instruction: prompts.QUESTION_TYPE_INSTRUCTIONS[questionType],
      }),
    },
  ];
  return { questionType, number, messages };
}

/**
 * Generate the single next question, given everything said so far.
 *
 * Throws RangeError if the interview is already complete — callers should
 * check isComplete() first.
 */
export async function nextQuestion(
  client: ChatClient,
  job: JobDescription,
  settings: InterviewSettings,
  transcript: TurnRecord[],
): Promise<TurnRecord> {
  const { questionType, number, messages } = nextQuestionMessages(job, settings, transcript);
  const text = await client.chat(messages, "question_generation");
  return { number, question_type: questionType, question: tidyQuestion(text), answer: null, evaluation: null };
}

/** Strip labels the model sometimes prefixes despite being told not to. */
export function tidyQuestion(text: string | null | undefined): string {
  let cleaned = pyStrip(text || "");
  for (const prefix of ["Question:", "Frage:", "Interviewer:", "Q:"]) {
    if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleaned = pyLstrip(cleaned.slice(prefix.length));
    }
  }
  return cleaned;
}

/**
 * Attach the user's answer to the most recent, still-unanswered question.
 * Returns a new transcript rather than mutating — React state wants that.
 */
export function recordAnswer(transcript: TurnRecord[], answer: string): TurnRecord[] {
  if (transcript.length === 0) throw new Error("There is no question to answer yet.");
  const last = transcript[transcript.length - 1];
  if (answered(last)) throw new Error("The latest question has already been answered.");
  return [...transcript.slice(0, -1), { ...last, answer: pyStrip(answer) }];
}

/** True once all questions have been asked *and* answered. */
export function isComplete(transcript: TurnRecord[], settings: InterviewSettings): boolean {
  return transcript.length >= totalQuestions(settings) && transcript.every(answered);
}

/** True when a question is on the table and the user has not replied yet. */
export function awaitingAnswer(transcript: TurnRecord[]): boolean {
  return transcript.length > 0 && !answered(transcript[transcript.length - 1]);
}

/** [questions answered, total questions] — for the progress bar. */
export function progress(transcript: TurnRecord[], settings: InterviewSettings): [number, number] {
  return [transcript.filter(answered).length, totalQuestions(settings)];
}
