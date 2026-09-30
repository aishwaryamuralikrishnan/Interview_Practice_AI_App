"use client";

/** Step 5 — the report. */

import { useEffect, useState, type ReactNode } from "react";

import * as config from "@/lib/config";
import {
  categoryAverages,
  categoryOverall,
  overallScore,
  perQuestionRows,
  scoreBand,
  transcriptToExport,
} from "@/lib/evaluation";
import { typeLabel } from "@/lib/interview";
import { displayTitle } from "@/lib/job";
import { modelLabel } from "@/lib/llm";
import { fetchReport, saveFile } from "@/lib/client/api";
import { formatInt, formatScore, truncate } from "@/lib/client/format";
import type { StageProps } from "../InterviewApp";
import { CriteriaRadar, QuestionBars } from "../charts";
import {
  Alert,
  BandDot,
  BulletList,
  Button,
  Card,
  CardHeader,
  CategoryDot,
  ConfirmButton,
  cx,
  Disclosure,
  NumberedList,
  ScorePill,
} from "../ui";

export default function ResultsStage({ state, dispatch }: StageProps) {
  const job = state.job!;
  const interview = state.interview!;
  const transcript = state.transcript;
  const summary = state.summary;

  const overall = overallScore(transcript);
  const byCategory = categoryOverall(transcript);
  const radars = categoryAverages(transcript);
  const rows = perQuestionRows(transcript).filter((r) => {
    const t = transcript.find((x) => x.number === r.number);
    return !t?.evaluation?.error;
  });
  const failures = transcript.filter((t) => t.evaluation?.error);

  const [openItems, setOpenItems] = useState<Set<number>>(() => new Set());
  const [showTable, setShowTable] = useState(false);

  // A printed report shows every answer, not only the ones left open.
  useEffect(() => {
    let before: Set<number> | null = null;
    const open = () => {
      setOpenItems((current) => {
        before = current;
        return new Set(transcript.map((t) => t.number));
      });
    };
    const restore = () => {
      if (before) setOpenItems(before);
    };
    window.addEventListener("beforeprint", open);
    window.addEventListener("afterprint", restore);
    return () => {
      window.removeEventListener("beforeprint", open);
      window.removeEventListener("afterprint", restore);
    };
  }, [transcript]);

  const toggle = (n: number) =>
    setOpenItems((current) => {
      const next = new Set(current);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const downloadJson = () => {
    const data = transcriptToExport(transcript, job, interview, summary ?? {}, state.modelSettings);
    saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "interview_report.json");
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const downloadPdf = async () => {
    setPdfBusy(true);
    setPdfError(null);
    const res = await fetchReport({ job, interview, settings: state.modelSettings, transcript, summary });
    setPdfBusy(false);
    if (res.ok) saveFile(res.blob, res.filename);
    else setPdfError(res.error);
  };

  const band = scoreBand(overall);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Your interview report</h1>
        <p className="mt-2 text-sm text-ink-2">
          {displayTitle(job)} · {interview.language} · {interview.difficulty} · {interview.attitude} interviewer ·{" "}
          {modelLabel(state.modelSettings)}
        </p>
      </div>

      {failures.length > 0 && (
        <Alert tone="warn" title={`${failures.length} answer${failures.length === 1 ? "" : "s"} could not be scored`}>
          <p>They are left out of the averages. The first error was: {failures[0].evaluation?.error}</p>
        </Alert>
      )}
      {summary?.error && (
        <Alert tone="warn" title="The overall summary couldn't be written">
          <p>Your scores below are complete. The error was: {summary.error}</p>
        </Alert>
      )}

      {/* -- headline ---------------------------------------------------- */}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card className="flex flex-col justify-between p-6">
          <p className="text-xs font-medium tracking-wider text-ink-3 uppercase">Overall score</p>
          <p className="mt-2 text-6xl font-semibold tracking-tight text-ink">
            {formatScore(overall)}
            <span className="ml-1 text-2xl font-medium text-ink-3">/ {config.SCORE_MAX}</span>
          </p>
          <p className="mt-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <BandDot score={overall} />
            {config.SCORE_BAND_LABELS[band]}
            {summary?.readiness && <span className="font-normal text-ink-2">· {summary.readiness}</span>}
          </p>
        </Card>
        <Card className="p-6">
          {summary?.headline && <h2 className="text-lg font-semibold text-ink">{summary.headline}</h2>}
          <div className={cx("grid gap-3 sm:grid-cols-3", summary?.headline && "mt-5")}>
            {config.QUESTION_TYPES.filter((t) => byCategory[t] !== undefined).map((t) => (
              <div key={t} className="rounded-xl bg-surface-2 p-4">
                <p className="flex items-center gap-2 text-xs text-ink-2">
                  <CategoryDot type={t} />
                  {config.QUESTION_TYPE_LABELS[t]}
                </p>
                <p className="mt-1 text-2xl font-semibold text-ink">
                  {formatScore(byCategory[t]!)}
                  <span className="ml-1 text-sm font-normal text-ink-3">/ {config.SCORE_MAX}</span>
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-2">
                  <BandDot score={byCategory[t]!} className="size-2" />
                  {config.SCORE_BAND_LABELS[scoreBand(byCategory[t]!)]}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {summary && (summary.what_worked.length > 0 || summary.suggested_improvements.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-6">
            <CardHeader icon="check" title="What worked" />
            <BulletList items={summary.what_worked} />
          </Card>
          <Card className="p-6">
            <CardHeader icon="sparkle" title="Suggested improvements" />
            <BulletList items={summary.suggested_improvements} />
          </Card>
        </div>
      )}

      {/* -- charts ------------------------------------------------------ */}
      {rows.length > 0 && (
        <Card className="space-y-8 p-6 print:break-inside-avoid">
          <QuestionBars rows={rows} />
          <div className="grid gap-6 border-t border-line pt-6 md:grid-cols-3">
            {config.QUESTION_TYPES.filter((t) => radars[t]).map((t) => (
              <CriteriaRadar key={t} type={t} scores={radars[t]!} />
            ))}
          </div>
          <div className="print:hidden">
            <Button size="sm" variant="ghost" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
              {showTable ? "Hide the numbers" : "Show the numbers as a table"}
            </Button>
            {showTable && <ScoreTable state={state} />}
          </div>
        </Card>
      )}

      {/* -- what each score means, stated once ------------------------- */}
      <section>
        <h2 className="text-xl font-semibold text-ink">How each answer was scored</h2>
        <p className="mt-1 text-sm text-ink-2">
          Every answer is marked out of {config.SCORE_MAX} on the four criteria for its question type. The scores in
          the analysis below refer to these.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {config.QUESTION_TYPES.map((t) => (
            <Card key={t} className="p-5">
              <p className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
                <CategoryDot type={t} className="size-2.5" />
                {config.QUESTION_TYPE_LABELS[t]}
              </p>
              <NumberedList items={Object.entries(config.RUBRICS[t]).map(([heading, description]) => ({ heading, description }))} />
            </Card>
          ))}
        </div>
      </section>

      {/* -- per-question detail ---------------------------------------- */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold text-ink">Deep analysis for each answer provided</h2>
          <button
            type="button"
            className="text-sm text-accent hover:underline print:hidden"
            onClick={() =>
              setOpenItems((c) => (c.size === transcript.length ? new Set() : new Set(transcript.map((t) => t.number))))
            }
          >
            {openItems.size === transcript.length ? "Collapse all" : "Expand all"}
          </button>
        </div>
        <Card className="mt-4 divide-y divide-line">
          {transcript.map((turn) => {
            const e = turn.evaluation;
            return (
              <Disclosure
                key={turn.number}
                open={openItems.has(turn.number)}
                onToggle={() => toggle(turn.number)}
                className="px-5 py-4 print:break-inside-avoid"
                summary={
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
                      <CategoryDot type={turn.question_type} />Q{turn.number}
                    </span>
                    <span className="text-xs text-ink-2">{typeLabel(turn)}</span>
                    {e && !e.error ? <ScorePill score={e.overall} /> : <span className="text-xs text-bad">Not scored</span>}
                    <span className="w-full text-sm text-ink-2 sm:w-auto sm:flex-1 sm:truncate">{truncate(turn.question, 90)}</span>
                  </span>
                }
              >
                <div className="space-y-5 pt-5 pb-1">
                  {e?.error ? (
                    <Alert tone="error" title="This answer could not be scored">
                      <p>{e.error}</p>
                    </Alert>
                  ) : (
                    <>
                      <Field n={1} label="Question">
                        <p className="whitespace-pre-wrap">{turn.question}</p>
                      </Field>
                      <Field n={2} label="Provided answer">
                        <p className="whitespace-pre-wrap">{turn.answer}</p>
                      </Field>
                      <Field n={3} label="Scores">
                        <div className="flex flex-wrap overflow-hidden rounded-xl border border-line">
                          <ScoreCell label="Overall" value={e!.overall} strong />
                          {Object.entries(e!.scores).map(([name, value]) => (
                            <ScoreCell key={name} label={name} value={value} />
                          ))}
                          {e!.suggested_improvement && (
                            <div className="min-w-[14rem] flex-1 border-t border-line p-3 sm:border-t-0 sm:border-l">
                              <p className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">Suggested improvement</p>
                              <p className="mt-1 text-sm text-ink">{e!.suggested_improvement}</p>
                            </div>
                          )}
                        </div>
                      </Field>
                      <Field n={4} label="Stronger version of the answer">
                        <p className="rounded-xl border border-accent/25 bg-accent-soft p-4 whitespace-pre-wrap">{e!.improved_answer || "—"}</p>
                      </Field>
                    </>
                  )}
                </div>
              </Disclosure>
            );
          })}
        </Card>
      </section>

      {summary?.closing_advice && (
        <section>
          <h2 className="text-xl font-semibold text-ink">Before the real thing</h2>
          <p className="mt-2 max-w-3xl text-base leading-relaxed whitespace-pre-line text-ink">{summary.closing_advice}</p>
        </section>
      )}

      {/* -- actions ----------------------------------------------------- */}
      <Card className="p-5 print:hidden">
        <div className="flex flex-wrap items-start gap-3">
          <Button variant="primary" icon="download" busy={pdfBusy} onClick={downloadPdf}>
            Download report (PDF)
          </Button>
          <Button icon="download" onClick={downloadJson}>
            Download data (JSON)
          </Button>
          <div className="flex-1" />
          <ConfirmButton
            label="Practise this role again"
            warning="This discards the report above and starts a fresh interview for the same role. Download it first if you want to keep it."
            confirmLabel="Yes, new interview"
            onConfirm={() => dispatch({ type: "practiseAgain" })}
          />
          <ConfirmButton
            label="Start over with a new job"
            warning="This discards the report above and returns you to the job link. Download it first if you want to keep it."
            confirmLabel="Yes, start over"
            onConfirm={() => dispatch({ type: "startOver" })}
          />
        </div>
        {pdfError && (
          <Alert tone="error" title="The PDF couldn't be built" className="mt-4">
            <p>{pdfError}</p>
          </Alert>
        )}
        <p className="mt-4 text-xs text-ink-3 tabular-nums">
          This session: {state.usage.calls} model calls · {formatInt(state.usage.total_tokens)} tokens (
          {formatInt(state.usage.reasoning_tokens)} of them reasoning).
        </p>
      </Card>
    </div>
  );
}

function Field({ n, label, children }: { n: number; label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold tracking-wide text-ink-3 uppercase">
        {n}. {label}
      </p>
      <div className="text-sm leading-relaxed text-ink">{children}</div>
    </div>
  );
}

function ScoreCell({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cx("min-w-[6.5rem] p-3", strong && "bg-surface-2")}>
      <p className="text-[11px] font-medium tracking-wide whitespace-nowrap text-ink-3 uppercase">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-base font-semibold text-ink tabular-nums">
        {strong && <BandDot score={value} className="size-2" />}
        {formatScore(value)}
        <span className="text-xs font-normal text-ink-3">/ {config.SCORE_MAX}</span>
      </p>
    </div>
  );
}

/** The chart values without the chart — so nothing is readable only by hovering. */
function ScoreTable({ state }: { state: StageProps["state"] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-ink-3">
            <th className="py-2 pr-4 font-medium">Question</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Criteria</th>
            <th className="py-2 text-right font-medium">Overall</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {state.transcript.map((t) => (
            <tr key={t.number} className="border-b border-line last:border-0">
              <td className="py-2 pr-4 font-medium text-ink">Q{t.number}</td>
              <td className="py-2 pr-4 text-ink-2">{typeLabel(t)}</td>
              <td className="py-2 pr-4 text-ink-2">
                {t.evaluation?.error
                  ? "not scored"
                  : Object.entries(t.evaluation?.scores ?? {})
                      .map(([k, v]) => `${k} ${v}`)
                      .join(" · ")}
              </td>
              <td className="py-2 text-right font-semibold text-ink">{t.evaluation?.error ? "—" : formatScore(t.evaluation?.overall ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
