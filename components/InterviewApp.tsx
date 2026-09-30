"use client";

/**
 * The app shell: header, stepper, and the one reducer every stage reads from
 * and dispatches to.
 */

import { useEffect, useReducer, useState, useSyncExternalStore, type Dispatch } from "react";

import { PAGE_TITLE } from "@/lib/config";
import { progress } from "@/lib/interview";
import { displayTitle } from "@/lib/job";
import { modelLabel } from "@/lib/llm";
import {
  initialState,
  loadState,
  reducer,
  saveState,
  STAGE_LABELS,
  STAGES,
  type Action,
  type AppState,
  type Stage,
} from "@/lib/client/state";
import { AUTH_REQUIRED_EVENT, fetchSession } from "@/lib/client/api";
import AccessGate from "./AccessGate";
import { Button, cx, Icon, Spinner } from "./ui";
import PostingStage from "./stages/PostingStage";
import ReviewStage from "./stages/ReviewStage";
import SetupStage from "./stages/SetupStage";
import InterviewStage from "./stages/InterviewStage";
import ResultsStage from "./stages/ResultsStage";

export interface StageProps {
  state: AppState;
  dispatch: Dispatch<Action>;
}

const noSubscribe = () => () => {};

/**
 * The saved session lives in sessionStorage, which exists only in the
 * browser. The server renders a placeholder; the browser renders the real
 * session, initialised straight from storage — no flash of step 1 on reload.
 */
export default function InterviewApp() {
  const inBrowser = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  if (!inBrowser) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-3">
        <Spinner className="size-6" />
      </div>
    );
  }
  return <Session />;
}

function Session() {
  const [state, dispatch] = useReducer(reducer, undefined, () => loadState() ?? initialState());
  // "locked" when the server wants an access code this browser hasn't given.
  const [gate, setGate] = useState<"checking" | "open" | "locked">("checking");

  useEffect(() => {
    let live = true;
    fetchSession().then((s) => {
      if (live) setGate(s.required && !s.authorised ? "locked" : "open");
    });
    // Any API call can report that the code is needed (e.g. it was changed).
    const lock = () => setGate("locked");
    window.addEventListener(AUTH_REQUIRED_EVENT, lock);
    return () => {
      live = false;
      window.removeEventListener(AUTH_REQUIRED_EVENT, lock);
    };
  }, []);

  useEffect(() => {
    saveState(state);
  }, [state]);

  // Each stage opens at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [state.stage]);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header state={state} dispatch={dispatch} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-16 sm:px-6 sm:pt-10">
        {gate === "checking" ? (
          <div className="flex justify-center py-24 text-ink-3">
            <Spinner className="size-6" />
          </div>
        ) : gate === "locked" ? (
          <AccessGate onUnlocked={() => setGate("open")} />
        ) : (
          <StageView state={state} dispatch={dispatch} />
        )}
      </main>
      <footer className="border-t border-line py-6 text-center text-xs text-ink-3 print:hidden">
        {PAGE_TITLE} · Next.js port · Model calls run on the server; your key never reaches this page.
      </footer>
    </div>
  );
}

function StageView(props: StageProps) {
  switch (props.state.stage) {
    case "job_input":
      return <PostingStage {...props} />;
    case "job_review":
      return <ReviewStage {...props} />;
    case "interview_setup":
      return <SetupStage {...props} />;
    case "interview":
      return <InterviewStage {...props} />;
    case "results":
      return <ResultsStage {...props} />;
  }
}

// ---------------------------------------------------------------------------

function Header({ state, dispatch }: StageProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur print:static print:border-0">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent" aria-hidden="true">
          <Icon name="chat" className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{PAGE_TITLE}</p>
          <p className="truncate text-xs text-ink-3">
            {state.job ? `Preparing for ${displayTitle(state.job)}` : "Practise a real interview for a real posting"}
            {" · "}
            {modelLabel(state.modelSettings)}
            {state.modelSettings.reasoning_effort ? ` · ${state.modelSettings.reasoning_effort} effort` : ""}
          </p>
        </div>
        {state.stage !== "job_input" && (
          <div className="print:hidden">
            <StartOver state={state} dispatch={dispatch} />
          </div>
        )}
      </div>
      <Stepper stage={state.stage} />
    </header>
  );
}

/** Say exactly what this particular click is about to destroy. */
function resetWarning(state: AppState): string {
  if (state.stage === "interview" && state.interview) {
    const [answered, total] = progress(state.transcript, state.interview);
    if (answered) {
      return `You're ${answered} of ${total} answers into this interview. Starting over deletes them and returns you to the job link.`;
    }
    return "This ends the interview before it has started and returns you to the job link.";
  }
  if (state.stage === "results") {
    return "This clears your report — scores, critiques and improved answers. Download it first if you want to keep it.";
  }
  return "This clears the job description and study plan, and returns you to the job link.";
}

function StartOver({ state, dispatch }: StageProps) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="relative">
      <Button variant="ghost" size="sm" icon="refresh" onClick={() => setAsking((v) => !v)} aria-expanded={asking}>
        Start over
      </Button>
      {asking && (
        <div
          role="alertdialog"
          aria-label="Start over?"
          className="absolute right-0 top-10 z-30 w-72 rounded-xl border border-line bg-surface p-4 text-sm shadow-lg"
        >
          <p className="mb-3 text-ink">{resetWarning(state)}</p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setAsking(false);
                dispatch({ type: "startOver" });
              }}
            >
              Yes, start over
            </Button>
            <Button size="sm" onClick={() => setAsking(false)} autoFocus>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stepper({ stage }: { stage: Stage }) {
  const index = STAGES.indexOf(stage);
  return (
    <nav aria-label="Progress" className="mx-auto max-w-5xl px-4 pb-3 sm:px-6 print:hidden">
      <p className="text-xs text-ink-2 sm:hidden">
        Step {index + 1} of {STAGES.length} · <span className="font-semibold text-ink">{STAGE_LABELS[stage]}</span>
      </p>
      <ol className="hidden items-center gap-2 sm:flex">
        {STAGES.map((s, i) => {
          const done = i < index;
          const current = i === index;
          return (
            <li key={s} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={current ? "step" : undefined}>
              <span
                className={cx(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  done && "bg-accent text-on-accent",
                  current && "bg-accent-soft text-accent ring-2 ring-accent",
                  !done && !current && "bg-surface-2 text-ink-3",
                )}
              >
                {done ? <Icon name="check" className="size-3.5" /> : i + 1}
              </span>
              <span className={cx("text-xs whitespace-nowrap", current ? "font-semibold text-ink" : done ? "text-ink-2" : "text-ink-3")}>
                {STAGE_LABELS[s]}
              </span>
              {i < STAGES.length - 1 && <span className={cx("h-px flex-1", done ? "bg-accent" : "bg-line-strong")} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
