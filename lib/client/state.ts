/**
 * The whole session in one reducer — what st.session_state was in the
 * Streamlit app, minus the rerun workarounds.
 *
 * Every transition is a pure function here, so the flow can be unit-tested
 * without rendering anything (tests/state.test.ts); the browser-level
 * behaviour is in e2e/flow.spec.ts.
 */

import * as config from "../config";
import type { Evaluation, OverallSummary } from "../evaluation";
import { recordAnswer, type InterviewSettings, type TurnRecord } from "../interview";
import { defaultModelSettings, type ModelSettings } from "../llm";
import type { JobDescription, PrepPlan } from "../job";
import { addUsage, EMPTY_USAGE, type UsageTotals } from "./api";

export const STAGES = ["job_input", "job_review", "interview_setup", "interview", "results"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  job_input: "Job posting",
  job_review: "Description & plan",
  interview_setup: "Interview setup",
  interview: "Mock interview",
  results: "Results",
};

export interface AppState {
  stage: Stage;
  modelSettings: ModelSettings;
  job: JobDescription | null;
  plan: PrepPlan | null;
  interview: InterviewSettings | null;
  transcript: TurnRecord[];
  summary: OverallSummary | null;
  usage: UsageTotals;
  /** Kept so a failed fetch or a trip back to step 1 doesn't lose what was typed. */
  jobUrl: string;
  pastedText: string;
}

export function initialState(): AppState {
  return {
    stage: "job_input",
    modelSettings: defaultModelSettings(),
    job: null,
    plan: null,
    interview: null,
    transcript: [],
    summary: null,
    usage: EMPTY_USAGE,
    jobUrl: "",
    pastedText: "",
  };
}

export type Action =
  | { type: "restore"; state: AppState }
  | { type: "setModelSettings"; settings: ModelSettings }
  | { type: "setInputs"; jobUrl?: string; pastedText?: string }
  | { type: "jobLoaded"; job: JobDescription; plan: PrepPlan; usage: UsageTotals }
  | { type: "goto"; stage: Stage }
  | { type: "beginInterview"; interview: InterviewSettings }
  | { type: "questionAsked"; turn: TurnRecord; usage: UsageTotals }
  | { type: "answered"; answer: string }
  | { type: "evaluated"; number: number; evaluation: Evaluation; usage?: UsageTotals }
  | { type: "summarised"; summary: OverallSummary; usage?: UsageTotals }
  | { type: "abandonInterview" }
  | { type: "practiseAgain" }
  | { type: "startOver" }
  | { type: "usage"; usage: UsageTotals };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "restore":
      return action.state;

    case "setModelSettings":
      return { ...state, modelSettings: action.settings };

    case "setInputs":
      return {
        ...state,
        jobUrl: action.jobUrl ?? state.jobUrl,
        pastedText: action.pastedText ?? state.pastedText,
      };

    case "jobLoaded":
      return {
        ...state,
        job: action.job,
        plan: action.plan,
        usage: addUsage(state.usage, action.usage),
        stage: "job_review",
      };

    case "goto":
      return { ...state, stage: action.stage };

    case "beginInterview":
      return { ...state, interview: action.interview, transcript: [], summary: null, stage: "interview" };

    case "questionAsked":
      // Ignore a late reply that no longer fits (e.g. the interview was
      // abandoned while the question was on its way).
      if (state.stage !== "interview" || action.turn.number !== state.transcript.length + 1) return state;
      return { ...state, transcript: [...state.transcript, action.turn], usage: addUsage(state.usage, action.usage) };

    case "answered":
      return { ...state, transcript: recordAnswer(state.transcript, action.answer) };

    case "evaluated":
      if (state.stage !== "interview") return state;
      return {
        ...state,
        transcript: state.transcript.map((t) => (t.number === action.number ? { ...t, evaluation: action.evaluation } : t)),
        usage: addUsage(state.usage, action.usage),
      };

    case "summarised":
      if (state.stage !== "interview") return state;
      return { ...state, summary: action.summary, usage: addUsage(state.usage, action.usage), stage: "results" };

    case "abandonInterview":
      // The Python reset_interview(): back to the posting, plan kept.
      return { ...state, transcript: [], summary: null, interview: null, stage: "job_review" };

    case "practiseAgain":
      return { ...state, transcript: [], summary: null, stage: "interview_setup" };

    case "startOver":
      // Keep only the model choice: it is a preference, not session data.
      return { ...initialState(), modelSettings: state.modelSettings };

    case "usage":
      return { ...state, usage: addUsage(state.usage, action.usage) };
  }
}

// ---------------------------------------------------------------------------
// Persistence — survive an accidental reload, which Streamlit never did.
// sessionStorage: per tab, gone when the tab closes, never sent anywhere.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "interview-practice-ai/v1";

export function saveState(state: AppState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Full or blocked storage just means no reload protection.
  }
}

export function loadState(): AppState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (!parsed || !STAGES.includes(parsed.stage as Stage)) return null;
    const merged = { ...initialState(), ...parsed } as AppState;
    // A stage whose data is missing would render nothing useful.
    if (merged.stage !== "job_input" && (!merged.job || !merged.plan)) return null;
    if ((merged.stage === "interview" || merged.stage === "results") && !merged.interview) return null;
    if (!(merged.modelSettings.model in config.MODEL_CHOICES)) merged.modelSettings = defaultModelSettings();
    return merged;
  } catch {
    return null;
  }
}

export function clearSavedState(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
