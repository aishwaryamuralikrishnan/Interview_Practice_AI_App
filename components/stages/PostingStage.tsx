"use client";

/** Step 1 — a link to the posting, or its pasted text. */

import { useEffect, useRef, useState, type FormEvent } from "react";

import { MIN_PASTED_CHARS } from "@/lib/config";
import { fetchJob } from "@/lib/client/api";
import type { StageProps } from "../InterviewApp";
import { Alert, Button, Card, cx, Icon, type IconName } from "../ui";
import ModelPanel from "./ModelPanel";

type Mode = "link" | "paste";

interface Problem {
  title: string;
  detail?: string;
}

export default function PostingStage({ state, dispatch }: StageProps) {
  const [mode, setMode] = useState<Mode>(state.pastedText && !state.jobUrl ? "paste" : "link");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  // A visible clock: two reasoning-model calls can take a minute, and a
  // spinner alone looks the same at second 5 as at second 50.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setElapsed(0);
    };
  }, [busy]);

  // After a failed fetch, put the cursor straight into the paste box.
  useEffect(() => {
    if (mode === "paste" && fetchFailed && !busy) pasteRef.current?.focus();
  }, [mode, fetchFailed, busy]);

  async function submit(source: Mode) {
    const url = state.jobUrl.trim();
    const text = source === "paste" ? state.pastedText : "";
    if (source === "link" && !url) {
      setProblem({ title: "Paste the link to the posting first." });
      return;
    }
    if (source === "paste" && Array.from(text.trim()).length < MIN_PASTED_CHARS) {
      setProblem({ title: "That's very short — paste the full posting so the questions can be specific." });
      return;
    }

    setBusy(true);
    setProblem(null);
    const res = await fetchJob({ url: source === "link" ? url : state.jobUrl, text, settings: state.modelSettings });
    setBusy(false);

    if (res.ok) {
      dispatch({ type: "jobLoaded", job: res.job, plan: res.plan, usage: res.usage });
      return;
    }
    setProblem({ title: res.error, detail: "hint" in res ? res.hint : undefined });
    if (res.stage === "fetch") {
      // As the Python app opened its paste box after a failed fetch.
      setFetchFailed(true);
      setMode("paste");
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(mode);
  };

  const pastedLength = Array.from(state.pastedText.trim()).length;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Prepare for a real interview</h1>
        <p className="mt-3 text-base text-ink-2">
          Share the job you&apos;re interviewing for. I&apos;ll pull out the description, work out what they&apos;re
          likely to ask, and then run a mock interview if you want one.
        </p>
      </div>

      <Card className="p-5 sm:p-6">
        <div role="tablist" aria-label="How to share the posting" className="mb-5 inline-flex rounded-xl bg-surface-2 p-1">
          {(
            [
              ["link", "Link", "link"],
              ["paste", "Paste text", "paste"],
            ] as [Mode, string, IconName][]
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => {
                setMode(id);
                setProblem(null);
              }}
              className={cx(
                "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
                mode === id ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink",
              )}
            >
              <Icon name={icon} className="size-4" />
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          {mode === "link" ? (
            <div>
              <label htmlFor="job-url" className="mb-2 block text-sm font-medium text-ink">
                Link to the job posting
              </label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  id="job-url"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  value={state.jobUrl}
                  onChange={(e) => dispatch({ type: "setInputs", jobUrl: e.target.value })}
                  placeholder="https://careers.example.com/jobs/data-engineer-1234"
                  disabled={busy}
                  className="h-12 w-full min-w-0 rounded-xl border sm:flex-1 border-line-strong bg-surface px-4 text-base text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <Button type="submit" variant="primary" size="lg" busy={busy} iconRight={busy ? undefined : "arrowRight"}>
                  Fetch the posting
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor="job-text" className="mb-2 block text-sm font-medium text-ink">
                Job description
              </label>
              <p className="mb-3 text-sm text-ink-2">
                LinkedIn, Indeed and Glassdoor block automated fetching. Open the posting, select the description and
                paste it here — everything after this works exactly the same.
              </p>
              <textarea
                id="job-text"
                ref={pasteRef}
                rows={10}
                value={state.pastedText}
                onChange={(e) => dispatch({ type: "setInputs", pastedText: e.target.value })}
                placeholder="Paste the full job posting here…"
                disabled={busy}
                className="w-full resize-y rounded-xl border border-line-strong bg-surface p-4 text-sm leading-relaxed text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <span className={cx("text-xs tabular-nums", pastedLength && pastedLength < MIN_PASTED_CHARS ? "text-ink-2" : "text-ink-3")}>
                  {pastedLength.toLocaleString("en-US")} characters
                  {pastedLength < MIN_PASTED_CHARS ? ` · at least ${MIN_PASTED_CHARS} needed` : ""}
                </span>
                <Button type="submit" variant="primary" size="lg" busy={busy} iconRight={busy ? undefined : "arrowRight"}>
                  Use this text
                </Button>
              </div>
            </div>
          )}

          {busy && (
            <p className="flex items-center gap-2 text-sm text-ink-2" aria-live="polite">
              {mode === "link" ? "Fetching the page, reading the posting" : "Reading the posting"} and working out what
              they&apos;ll ask you… <span className="tabular-nums text-ink-3">{elapsed}s</span>
            </p>
          )}

          {problem && !busy && (
            <Alert tone={fetchFailed && mode === "paste" ? "warn" : "error"} title={problem.title}>
              {problem.detail && <p>{problem.detail}</p>}
              {fetchFailed && mode === "paste" && <p>You can paste the posting&apos;s text below instead.</p>}
            </Alert>
          )}
        </form>
      </Card>

      <ModelPanel settings={state.modelSettings} onChange={(settings) => dispatch({ type: "setModelSettings", settings })} usage={state.usage} />

      <ol className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["doc", "Read the posting", "Skills, likely topics and a short study plan, straight from the ad."],
            ["chat", "Mock interview", "One question at a time, in the language, difficulty and tone you choose."],
            ["sparkle", "Scored report", "Every answer marked against a rubric, with a stronger version written for you."],
          ] as [IconName, string, string][]
        ).map(([icon, title, text], i) => (
          <li key={title} className="flex gap-3 rounded-2xl p-4">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name={icon} className="size-[18px]" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-ink">
                {i + 1}. {title}
              </span>
              <span className="block text-sm text-ink-2">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
