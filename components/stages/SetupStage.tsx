"use client";

/** Step 3 — the choices that shape the interview. Nothing else changes. */

import { useState } from "react";

import * as config from "@/lib/config";
import { splitQuestions } from "@/lib/interview";
import { estimatedCost } from "@/lib/llm";
import { ATTITUDE_NOTES, DIFFICULTY_NOTES, LANGUAGE_NOTES } from "@/lib/client/copy";
import { formatUsd } from "@/lib/client/format";
import type { StageProps } from "../InterviewApp";
import { Button, Card, CategoryDot, Icon, OptionCards } from "../ui";

export default function SetupStage({ state, dispatch }: StageProps) {
  // Start from the last interview's choices when practising the same role again.
  const previous = state.interview;
  const [language, setLanguage] = useState<config.Language>(previous?.language ?? config.DEFAULT_LANGUAGE);
  const [difficulty, setDifficulty] = useState<config.Difficulty>(previous?.difficulty ?? config.DEFAULT_DIFFICULTY);
  const [attitude, setAttitude] = useState<config.Attitude>(previous?.attitude ?? config.DEFAULT_ATTITUDE);
  const [count, setCount] = useState<number>(previous?.num_questions ?? config.DEFAULT_QUESTIONS);

  // The field keeps its own text while typing, so "12" can be typed through "1".
  const [draft, setDraft] = useState(String(count));

  const split = splitQuestions(count);
  const clamp = (n: number) => Math.max(config.MIN_QUESTIONS, Math.min(config.MAX_QUESTIONS, Math.round(n)));
  const step = (delta: number) => {
    const next = clamp(count + delta);
    setCount(next);
    setDraft(String(next));
  };

  const option = (title: string, note: string) => (
    <>
      <span className="block text-sm font-semibold text-ink">{title}</span>
      <span className="mt-0.5 block text-xs text-ink-2">{note}</span>
    </>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Set up your mock interview</h1>
        <p className="mt-2 text-base text-ink-2">These choices shape the interview. Nothing else changes.</p>
      </div>

      <Card className="space-y-7 p-5 sm:p-6">
        <OptionCards
          label="Interview language — questions, feedback and improved answers"
          options={config.LANGUAGE_OPTIONS}
          value={language}
          onChange={setLanguage}
          columns="sm:grid-cols-2"
          render={(o) => option(o, LANGUAGE_NOTES[o])}
        />
        <OptionCards
          label="Difficulty"
          options={config.DIFFICULTY_OPTIONS}
          value={difficulty}
          onChange={setDifficulty}
          render={(o) => option(o, DIFFICULTY_NOTES[o])}
        />
        <OptionCards
          label="Interviewer's attitude"
          options={config.ATTITUDE_OPTIONS}
          value={attitude}
          onChange={setAttitude}
          render={(o) => option(o, ATTITUDE_NOTES[o])}
        />

        <div>
          <label htmlFor="num-questions" className="mb-2 block text-sm font-medium text-ink">
            How many questions?
          </label>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="inline-flex items-center rounded-xl border border-line-strong bg-surface">
              <button
                type="button"
                aria-label="One question fewer"
                onClick={() => step(-1)}
                disabled={count <= config.MIN_QUESTIONS}
                className="inline-flex size-11 items-center justify-center text-ink-2 hover:text-ink disabled:opacity-40"
              >
                <Icon name="minus" />
              </button>
              <input
                id="num-questions"
                type="number"
                inputMode="numeric"
                min={config.MIN_QUESTIONS}
                max={config.MAX_QUESTIONS}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= config.MIN_QUESTIONS && n <= config.MAX_QUESTIONS) setCount(n);
                }}
                onBlur={() => setDraft(String(count))}
                className="h-11 w-14 border-x border-line bg-transparent text-center text-base font-semibold tabular-nums text-ink [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                type="button"
                aria-label="One question more"
                onClick={() => step(1)}
                disabled={count >= config.MAX_QUESTIONS}
                className="inline-flex size-11 items-center justify-center text-ink-2 hover:text-ink disabled:opacity-40"
              >
                <Icon name="plus" />
              </button>
            </div>

            {/* The live split, as the Python caption showed it. */}
            <div className="min-w-0 flex-1" aria-live="polite">
              <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                {(["intro", "technical", "behavioural"] as const).map((t) =>
                  Array.from({ length: split[t] }, (_, i) => (
                    <span key={`${t}${i}`} className={`flex-1 ${{ intro: "bg-cat-intro", technical: "bg-cat-technical", behavioural: "bg-cat-behavioural" }[t]}`} />
                  )),
                )}
              </div>
              <p className="mt-2 text-sm text-ink-2">
                That&apos;s {split.intro} self-introduction, {split.technical} technical and {split.behavioural} behavioural.
              </p>
              <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                {(["intro", "technical", "behavioural"] as const).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1.5">
                    <CategoryDot type={t} />
                    {config.QUESTION_TYPE_LABELS[t]}
                  </span>
                ))}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-3">
            {config.MIN_QUESTIONS}–{config.MAX_QUESTIONS} questions. One self-introduction, then the rest split evenly;
            an odd one goes to technical. About {formatUsd(estimatedCost(state.modelSettings, count))} on{" "}
            {config.MODEL_CHOICES[state.modelSettings.model]?.label}.
          </p>
        </div>
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" icon="arrowLeft" onClick={() => dispatch({ type: "goto", stage: "job_review" })}>
          Back to the job description
        </Button>
        <Button
          variant="primary"
          size="lg"
          iconRight="arrowRight"
          onClick={() =>
            dispatch({ type: "beginInterview", interview: { language, difficulty, attitude, num_questions: count } })
          }
        >
          Begin the interview
        </Button>
      </div>
    </div>
  );
}
