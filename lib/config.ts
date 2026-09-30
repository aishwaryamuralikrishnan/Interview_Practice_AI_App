/**
 * config.ts — DEVELOPER SETTINGS ONLY.
 *
 * Everything in this file is a knob for you, the developer: which model to
 * call, how it is sampled, how long answers may be, how many questions the
 * interview has, and which criteria each answer is scored on.
 *
 * Nothing the end user chooses at runtime (interview language, difficulty,
 * interviewer attitude) lives here — those are collected in the UI and passed
 * through as `InterviewSettings` (see interview.ts). The natural-language
 * prompt text lives in prompts.ts.
 *
 * Ported from config.py. Values are identical; tests/parity.test.ts checks
 * every one against the Python original.
 */

// ---------------------------------------------------------------------------
// 1. API / provider
// ---------------------------------------------------------------------------

export const API_BASE_URL = "https://openrouter.ai/api/v1";
export const API_KEY_ENV_VAR = "OPENROUTER_API_KEY";

// Optional OpenRouter attribution headers (shown on openrouter.ai rankings).
// Safe to leave as-is or blank them out. (Streamlit ran on :8501; Next.js
// runs on :3000.)
export const OPENROUTER_APP_URL = "http://localhost:3000";
export const OPENROUTER_APP_TITLE = "Interview Practice AI";

export const REQUEST_TIMEOUT_SECONDS = 180;
export const MAX_RETRIES = 3; // retries on 429 / 5xx / network errors
export const RETRY_BACKOFF_SECONDS = 2.0; // doubles each retry

// ---------------------------------------------------------------------------
// 2. Model + sampling
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "openai/gpt-5-mini";

export interface ModelChoice {
  label: string;
  tag: string;
  /** Exactly five words — shown beside the option in a radio list. */
  advantage: string;
  /** Exactly five words. */
  disadvantage: string;
  /** USD per million input tokens. */
  price_in: number;
  /** USD per million output tokens. */
  price_out: number;
  /**
   * Whether the model accepts temperature / top_p / frequency_penalty /
   * presence_penalty. Every GPT-5 model rejects them with a 400; their tunable
   * equivalent is reasoning effort.
   */
  supports_sampling: boolean;
}

// The models offered to the user in step 1. Add an entry to offer another.
export const MODEL_CHOICES: Record<string, ModelChoice> = {
  "openai/gpt-5-mini": {
    label: "GPT-5 mini",
    tag: "Recommended",
    advantage: "Strong reasoning at low cost",
    disadvantage: "Occasionally misses subtle technical nuance",
    price_in: 0.25,
    price_out: 2.0,
    supports_sampling: false,
  },
  "openai/gpt-5-nano": {
    label: "GPT-5 nano",
    tag: "Cheapest",
    advantage: "Cheapest and fastest by far",
    disadvantage: "Shallow feedback, misses technical errors",
    price_in: 0.05,
    price_out: 0.4,
    supports_sampling: false,
  },
  "openai/gpt-5": {
    label: "GPT-5",
    tag: "Most capable",
    advantage: "Sharpest questions, most reliable scoring",
    disadvantage: "Five times mini's cost, slower",
    price_in: 1.25,
    price_out: 10.0,
    supports_sampling: false,
  },
};

/** True when temperature/top_p may be sent to this model. */
export function modelSupportsSampling(model: string): boolean {
  return Boolean(MODEL_CHOICES[model]?.supports_sampling);
}

// ---------------------------------------------------------------------------
// 2b. What the user may tune, and within what bounds
// ---------------------------------------------------------------------------

export const SHOW_TUNING_PANEL = true;

// The GPT-5 stand-in for temperature: how much the model thinks before
// answering. It changes depth, not randomness.
export const REASONING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_OPTIONS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

// max_tokens is a CEILING, not a spend: you are billed for what is generated,
// so a generous cap costs nothing. The floor is deliberately high because on a
// reasoning model the budget covers invisible reasoning tokens too.
export const MAX_TOKENS_MIN = 3_000;
export const MAX_TOKENS_MAX = 16_000;
export const MAX_TOKENS_STEP = 1_000;
export const DEFAULT_MAX_TOKENS = 8_000;

// Only rendered for a model where supports_sampling is true.
export const TEMPERATURE_MIN = 0.0;
export const TEMPERATURE_MAX = 2.0;
export const TEMPERATURE_STEP = 0.1;
export const DEFAULT_TEMPERATURE = 0.7;

// Seed is a prompt-tuning instrument, not a practice setting. Fixing it makes
// an identical request return an identical response (best-effort), so a
// difference between two runs is attributable to your prompt edit.
export const DEFAULT_USE_SEED = false;
export const DEFAULT_SEED = 42;

// Rough token cost of ONE COMPLETE RUN, for the estimate shown in the panel.
// BASE = the three fixed calls; PER_QUESTION = generating + evaluating one.
export const EST_INPUT_TOKENS_BASE = 6_000;
export const EST_INPUT_TOKENS_PER_QUESTION = 3_300;
export const EST_OUTPUT_TOKENS_BASE = 3_300;
export const EST_OUTPUT_TOKENS_PER_QUESTION = 1_560;

export interface ModelProfile {
  model: string;
  reasoning_effort?: ReasoningEffort;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

export const PROFILE_NAMES = ["job_extraction", "prep_plan", "question_generation", "evaluation"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

// One profile per task the app performs. Tune these independently.
export const MODEL_PROFILES: Record<ProfileName, ModelProfile> = {
  // Turning a raw job-posting page into structured JSON.
  job_extraction: {
    model: DEFAULT_MODEL,
    reasoning_effort: "low",
    max_tokens: 6000,
    temperature: 0.1, // only sent to a model that accepts it
  },
  // Key skills / likely topics / study plan.
  prep_plan: {
    model: DEFAULT_MODEL,
    reasoning_effort: "medium",
    max_tokens: 8000,
    temperature: 0.4,
  },
  // Generating the next interview question (one at a time).
  question_generation: {
    model: DEFAULT_MODEL,
    reasoning_effort: "medium",
    max_tokens: 3000,
    temperature: 0.8,
  },
  // Critiquing + scoring a single answer and writing an improved version.
  evaluation: {
    model: DEFAULT_MODEL,
    reasoning_effort: "medium",
    max_tokens: 8000,
    temperature: 0.2,
  },
};

// ---------------------------------------------------------------------------
// 3. Job-posting retrieval
// ---------------------------------------------------------------------------

export const SCRAPER_TIMEOUT_SECONDS = 25;

// Sent so that ordinary career pages don't 403 us. LinkedIn, Indeed and
// Glassdoor block server-side fetches regardless — the app falls back to
// "paste the posting text" in that case.
export const SCRAPER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
};

// Domains known to block plain HTTP scraping — we skip the attempt and go
// straight to the paste box with a helpful message.
export const KNOWN_BLOCKED_DOMAINS = [
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
] as const;

// How much page text to hand the model.
export const MAX_JOB_TEXT_CHARS = 40_000;

// The shortest pasted posting accepted. Hard-coded in app.py; here in config
// because both the API and the page need it. (Not a Python config constant,
// so the parity test does not look for it.)
export const MIN_PASTED_CHARS = 120;

// Postings not in DISPLAY_LANGUAGE are translated into it during extraction —
// no extra API call. The interview language is the user's own choice.
export const TRANSLATE_JOB_DESCRIPTION = true;
export const DISPLAY_LANGUAGE = "English";

// ---------------------------------------------------------------------------
// 3b. Preparation-plan shape
// ---------------------------------------------------------------------------
// Caps are enforced twice: asked for in the prompt, and trimmed in code.

export const MAX_KEY_SKILLS = 12;
export const MAX_INTERVIEW_TOPICS = 6;
export const NUM_STUDY_STRATEGIES = 3;

// ---------------------------------------------------------------------------
// 4. Interview shape
// ---------------------------------------------------------------------------

export const NUM_INTRO_QUESTIONS = 1;

// One self-introduction, then the remainder split evenly between technical and
// behavioural, with the odd question going to technical.
export const MIN_QUESTIONS = 3; // the floor that still gives one of every type
export const MAX_QUESTIONS = 20;
export const DEFAULT_QUESTIONS = 5;

export const LANGUAGE_OPTIONS = ["English", "German"] as const;
export const DIFFICULTY_OPTIONS = ["Easy", "Medium", "Hard"] as const;
export const ATTITUDE_OPTIONS = ["Neutral", "Friendly", "Strict"] as const;

export type Language = (typeof LANGUAGE_OPTIONS)[number];
export type Difficulty = (typeof DIFFICULTY_OPTIONS)[number];
export type Attitude = (typeof ATTITUDE_OPTIONS)[number];

export const DEFAULT_LANGUAGE: Language = "English";
export const DEFAULT_DIFFICULTY: Difficulty = "Medium";
export const DEFAULT_ATTITUDE: Attitude = "Neutral";

// ---------------------------------------------------------------------------
// 5. Scoring rubric
// ---------------------------------------------------------------------------

export const SCORE_MAX = 10;

// The rewritten answer is capped in code as well as in the prompt.
export const MAX_IMPROVED_ANSWER_SENTENCES = 3;

// The overall summary's two lists, one sentence per entry.
export const MAX_SUMMARY_POINTS = 4;

// Few-shot scoring anchors in the evaluation prompt. Turn off to compare; fix
// the seed to compare fairly.
export const USE_EVALUATION_ANCHORS = true;

export const QUESTION_TYPES = ["intro", "technical", "behavioural"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

// Insertion order matters: it is the order criteria are listed in the prompt
// and on the radar chart. JS preserves string-key order, as Python dicts do.
export const RUBRICS: Record<QuestionType, Record<string, string>> = {
  intro: {
    Clarity:
      "Is the introduction clear, well-paced and easy to follow, without " +
      "rambling or unexplained jargon?",
    "Skills Match":
      "Are the skills named the ones this specific job description asks " +
      "for, and are they backed by evidence rather than just claimed?",
    "Experience Relevance":
      "Is the experience described actually relevant to this role's " +
      "seniority, domain and day-to-day responsibilities?",
    "Background Fit":
      "Does the overall professional background — trajectory, education, " +
      "motivation — line up with what this employer is hiring for?",
  },
  technical: {
    Context:
      "Does the answer address the question that was actually asked, at " +
      "the right level of detail, and connect to the role's real context?",
    "Technical Knowledge":
      "Is the content technically correct, appropriately deep, and free " +
      "of hand-waving or invented facts?",
    Structure:
      "Is the answer organised — a clear opening claim, a logical build, " +
      "a conclusion — rather than a stream of consciousness?",
    Language:
      "Is the wording precise, professional and fluent in the interview " +
      "language, using correct terminology?",
  },
  behavioural: {
    Situation: "Is the context set concretely — where, when, who was involved, what was at stake?",
    Task: "Is the candidate's own responsibility and the goal stated clearly?",
    Action: "Are the specific steps the candidate personally took described, rather than what 'we' did?",
    Result: "Is there a concrete, ideally quantified outcome, plus what was learned?",
  },
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  intro: "Self-introduction",
  technical: "Technical",
  behavioural: "Behavioural",
};

// ---------------------------------------------------------------------------
// 6. UI / chart appearance
// ---------------------------------------------------------------------------

// Validated colour-blind-safe against each other in both modes.
export const CATEGORY_COLORS = {
  light: { intro: "#2a78d6", technical: "#eb6834", behavioural: "#1baf7a" },
  dark: { intro: "#3987e5", technical: "#d95926", behavioural: "#199e70" },
} as const;

// Always shown alongside the number itself — colour never carries meaning alone.
export const SCORE_BAND_COLORS = {
  strong: "#0ca30c", // >= 8
  ok: "#fab219", // >= 5
  weak: "#d03b3b", // < 5
} as const;

export const SCORE_BAND_LABELS = {
  strong: "Strong",
  ok: "Adequate",
  weak: "Needs work",
} as const;

export type ScoreBand = keyof typeof SCORE_BAND_COLORS;

export const ACCENT_COLORS = { light: "#2a78d6", dark: "#3987e5" } as const;

export const CHART_THEME = {
  light: {
    surface: "#fcfcfb",
    text_primary: "#0b0b0b",
    text_muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
  },
  dark: {
    surface: "#1a1a19",
    text_primary: "#ffffff",
    text_muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
  },
} as const;

export const PAGE_TITLE = "Interview Practice AI";
export const PAGE_ICON = "🎯";

// A debugging aid, not a user feature.
export const SHOW_DEVELOPER_PANEL = false;
