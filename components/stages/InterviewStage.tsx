"use client";

/**
 * Step 4 — the interview, one question at a time, then the scoring.
 *
 * The next thing to do is derived from the transcript, not stored:
 *   no question waiting for an answer → ask the next one
 *   a question waiting               → the user's turn
 *   all answered, some unscored      → score the next one
 *   all scored                       → write the summary, then show results
 * One effect performs whichever step is due. Because it is derived, a page
 * reload mid-interview resumes exactly where it stopped.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { answered, awaitingAnswer, isComplete, progress, typeLabel } from "@/lib/interview";
import { displayTitle } from "@/lib/job";
import { fetchEvaluation, fetchQuestion, fetchSummary, type InterviewContext } from "@/lib/client/api";
import type { StageProps } from "../InterviewApp";
import { Alert, Button, CategoryDot, ConfirmButton, cx, Icon, ProgressBar } from "../ui";

type Phase = "asking" | "answering" | "scoring" | "summarising";

export default function InterviewStage({ state, dispatch }: StageProps) {
  const job = state.job!;
  const interview = state.interview!;
  const transcript = state.transcript;
  const total = interview.num_questions;
  const [answeredCount] = progress(transcript, interview);
  const scoredCount = transcript.filter((t) => t.evaluation).length;

  const phase: Phase = !isComplete(transcript, interview)
    ? awaitingAnswer(transcript)
      ? "answering"
      : "asking"
    : scoredCount < transcript.length
      ? "scoring"
      : "summarising";

  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Perform whichever model call is due. The ref keeps it to one at a time —
  // including under React's development double-invocation of effects.
  useEffect(() => {
    if (phase === "answering" || error || inFlight.current) return;
    const ctx: InterviewContext = { job, interview, settings: state.modelSettings };
    inFlight.current = true;

    // The flag is cleared BEFORE dispatching, so the re-render that the
    // dispatch causes is free to start the next step.
    const step = async () => {
      if (phase === "asking") {
        const res = await fetchQuestion(ctx, transcript);
        inFlight.current = false;
        if (res.ok) dispatch({ type: "questionAsked", turn: res.turn, usage: res.usage });
        else setError(res.error);
      } else if (phase === "scoring") {
        const turn = transcript.find((t) => !t.evaluation)!;
        const res = await fetchEvaluation(ctx, turn);
        inFlight.current = false;
        if (res.ok) dispatch({ type: "evaluated", number: turn.number, evaluation: res.evaluation, usage: res.usage });
        else setError(res.error);
      } else {
        const res = await fetchSummary(ctx, transcript);
        inFlight.current = false;
        if (res.ok) dispatch({ type: "summarised", summary: res.summary, usage: res.usage });
        else setError(res.error);
      }
    };
    step().catch((exc: unknown) => {
      inFlight.current = false;
      setError(String(exc));
    });
  }, [phase, error, transcript, job, interview, state.modelSettings, dispatch]);

  // Keep the newest message in view.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length, answeredCount, phase]);

  return (
    <div className="space-y-5">
      {/* -- header ------------------------------------------------------ */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Mock interview</h1>
            <p className="mt-1 text-sm text-ink-2">
              {displayTitle(job)} · {interview.language} · {interview.difficulty} · {interview.attitude} interviewer
            </p>
          </div>
          <p className="text-sm font-medium text-ink tabular-nums">
            Question {Math.min(answeredCount + 1, total)} of {total}
          </p>
        </div>
        <ProgressBar value={answeredCount / total} label="Interview progress" />
      </div>

      {/* -- conversation ------------------------------------------------ */}
      <ol className="space-y-5" aria-live="polite" aria-label="Conversation">
        {transcript.map((turn) => (
          <li key={turn.number} className="space-y-5">
            <Bubble side="interviewer">
              <p className="mb-1.5 flex items-center gap-2 text-xs text-ink-3">
                <CategoryDot type={turn.question_type} />
                Question {turn.number} of {total} · {typeLabel(turn)}
              </p>
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{turn.question}</p>
            </Bubble>
            {answered(turn) && (
              <Bubble side="candidate">
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{turn.answer}</p>
              </Bubble>
            )}
          </li>
        ))}
        {phase === "asking" && !error && (
          <li>
            <Bubble side="interviewer">
              <span className="sr-only">{transcript.length ? "The interviewer is thinking…" : "The interviewer is joining…"}</span>
              <span className="flex items-center gap-1.5 py-1" aria-hidden="true">
                <span className="typing-dot size-2 rounded-full bg-ink-3" />
                <span className="typing-dot size-2 rounded-full bg-ink-3" />
                <span className="typing-dot size-2 rounded-full bg-ink-3" />
                <span className="ml-2 text-xs text-ink-3">{transcript.length ? "The interviewer is thinking…" : "The interviewer is joining…"}</span>
              </span>
            </Bubble>
          </li>
        )}
      </ol>

      {error && (
        <Alert
          tone="error"
          title={phase === "summarising" ? "The overall summary couldn't be written." : "Something went wrong."}
          action={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" icon="refresh" onClick={() => setError(null)}>
                Try again
              </Button>
              {phase === "summarising" && (
                <Button
                  size="sm"
                  onClick={() => {
                    setError(null);
                    dispatch({
                      type: "summarised",
                      summary: { headline: "", readiness: "", what_worked: [], suggested_improvements: [], closing_advice: "", error },
                    });
                  }}
                >
                  Show my scores without it
                </Button>
              )}
            </div>
          }
        >
          <p>{error}</p>
        </Alert>
      )}

      {(phase === "scoring" || phase === "summarising") && (
        <ScoringPanel total={transcript.length} scored={scoredCount} summarising={phase === "summarising"} failed={Boolean(error)} />
      )}

      {/* Scrolled to on every new message; the margin clears the sticky composer. */}
      <div ref={endRef} className="scroll-mb-44" />

      {/* -- the user's turn --------------------------------------------- */}
      {(phase === "answering" || phase === "asking") && (
        <div className="sticky bottom-0 z-10 -mx-4 bg-bg px-4 pt-2 pb-4 sm:-mx-6 sm:px-6">
          <div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-bg to-transparent" aria-hidden="true" />
          <Composer
            disabled={phase !== "answering"}
            onSend={(answer) => dispatch({ type: "answered", answer })}
          />
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <p className="text-xs text-ink-3">
              Enter sends · Shift+Enter for a new line. Answer as you would out loud — you won&apos;t get feedback until
              the end; that&apos;s the point.
            </p>
            <ConfirmButton
              label="End without scoring"
              warning="This ends the interview without scoring it and returns you to the job description. Your answers so far are discarded."
              confirmLabel="Yes, end it"
              variant="ghost"
              onConfirm={() => dispatch({ type: "abandonInterview" })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Bubble({ side, children }: { side: "interviewer" | "candidate"; children: ReactNode }) {
  const mine = side === "candidate";
  return (
    <div className={cx("flex items-start gap-3", mine && "flex-row-reverse")}>
      <span
        className={cx(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          mine ? "bg-accent text-on-accent" : "bg-surface-3 text-ink-2",
        )}
        aria-hidden="true"
      >
        {mine ? "You" : <Icon name="chat" className="size-4" />}
      </span>
      <div
        className={cx(
          "max-w-[min(42rem,calc(100%-3rem))] rounded-2xl px-4 py-3",
          mine ? "rounded-tr-md bg-accent-soft" : "rounded-tl-md border border-line bg-surface",
        )}
      >
        <span className="sr-only">{mine ? "You:" : "Interviewer:"}</span>
        {children}
      </div>
    </div>
  );
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (answer: string) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus the box whenever it becomes the user's turn.
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  // Grow with the answer, up to a limit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const send = () => {
    if (disabled || !text.trim()) return;
    onSend(text);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, as Streamlit's chat input did; Shift+Enter is a new line.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface p-2 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
      <label htmlFor="answer" className="sr-only">
        Your answer
      </label>
      <textarea
        id="answer"
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={disabled ? "Waiting for the interviewer…" : "Type your answer…"}
        className="max-h-[260px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none disabled:cursor-not-allowed"
      />
      <Button variant="primary" onClick={send} disabled={disabled || !text.trim()} aria-label="Send answer" className="size-10 px-0">
        <Icon name="send" />
      </Button>
    </div>
  );
}

function ScoringPanel({ total, scored, summarising, failed }: { total: number; scored: number; summarising: boolean; failed: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5" role="status">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon name="check" className="size-4 text-good" />
        That&apos;s all {total} questions. Scoring your answers now…
      </p>
      <div className="mt-4">
        <ProgressBar value={summarising ? 1 : scored / total} label="Scoring progress" />
      </div>
      <p className="mt-2 text-xs text-ink-2 tabular-nums">
        {failed
          ? "Paused."
          : summarising
            ? "Writing your overall summary…"
            : `Scoring answer ${Math.min(scored + 1, total)} of ${total}…`}{" "}
        <span className="text-ink-3">One model call per answer, then one for the summary.</span>
      </p>
    </div>
  );
}
