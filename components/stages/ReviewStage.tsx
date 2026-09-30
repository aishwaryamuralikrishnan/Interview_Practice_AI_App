"use client";

/** Step 2 — the posting as understood, and the preparation plan. */

import { useState } from "react";

import { DISPLAY_LANGUAGE } from "@/lib/config";
import { displayTitle, hasOriginal } from "@/lib/job";
import { hostOf, safeHref } from "@/lib/client/format";
import type { StageProps } from "../InterviewApp";
import { Alert, BulletList, Button, Card, CardHeader, Chip, Disclosure, Icon, NumberedList, TabPanel, Tabs } from "../ui";

type Tab = "description" | "skills" | "topics" | "plan";

export default function ReviewStage({ state, dispatch }: StageProps) {
  const job = state.job!;
  const plan = state.plan!;
  const [tab, setTab] = useState<Tab>("description");
  const [showOriginal, setShowOriginal] = useState(false);
  const [declined, setDeclined] = useState(false);

  const meta = [job.location, job.employment_type, job.seniority].filter((m): m is string => Boolean(m));
  const href = job.source_url ? safeHref(job.source_url) : null;

  return (
    <div className="space-y-6">
      {/* -- the posting ------------------------------------------------- */}
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{displayTitle(job)}</h1>
        {(meta.length > 0 || job.source_url) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {meta.map((m) => (
              <Chip key={m}>{m}</Chip>
            ))}
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                <Icon name="link" className="size-3.5" />
                {hostOf(href)}
              </a>
            ) : job.source_url ? (
              <span className="text-xs text-ink-3">{job.source_url}</span>
            ) : null}
          </div>
        )}
        {job.was_translated && (
          <p className="mt-3 flex items-start gap-2 text-sm text-ink-2">
            <Icon name="globe" className="mt-0.5 size-4 text-ink-3" />
            Translated from {job.language_of_posting || "the original language"} into {DISPLAY_LANGUAGE}.
            Country-specific employment terms keep the original word in brackets.
          </p>
        )}
        {job.summary && <p className="mt-4 max-w-3xl text-base leading-relaxed text-ink">{job.summary}</p>}
      </div>

      {job.injection_notice && (
        <Alert tone="warn" title="This page tried to give instructions to the model.">
          <p>{job.injection_notice}</p>
          <p>
            The instructions were ignored and the posting was extracted normally — but treat this page, and any link on
            it, with caution.
          </p>
        </Alert>
      )}

      {job.was_translated && hasOriginal(job) && (
        <Card className="px-5 py-4">
          <Disclosure
            open={showOriginal}
            onToggle={() => setShowOriginal((v) => !v)}
            summary={
              <span className="text-sm font-medium text-ink">
                Read the original {job.language_of_posting || ""} posting
              </span>
            }
          >
            <div className="mt-4 space-y-4 text-sm">
              <p className="text-ink-2">
                The description, duties and requirements exactly as the posting words them, with its own bullet
                structure kept. Nothing else from the page is included.
              </p>
              {job.original_description && (
                <div>
                  <p className="mb-1 font-semibold text-ink">Description</p>
                  <p className="whitespace-pre-line text-ink">{job.original_description}</p>
                </div>
              )}
              {job.original_responsibilities.length > 0 && (
                <div>
                  <p className="mb-2 font-semibold text-ink">Responsibilities</p>
                  <BulletList items={job.original_responsibilities} />
                </div>
              )}
              {job.original_requirements.length > 0 && (
                <div>
                  <p className="mb-2 font-semibold text-ink">Requirements</p>
                  <BulletList items={job.original_requirements} />
                </div>
              )}
            </div>
          </Disclosure>
        </Card>
      )}

      {/* -- details and plan -------------------------------------------- */}
      <Card className="px-5 pb-6 sm:px-6">
        <Tabs
          label="Posting and preparation plan"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "description", label: "Job description" },
            { id: "skills", label: "Key skills", count: plan.key_skills.length },
            { id: "topics", label: "Likely topics", count: plan.interview_topics.length },
            { id: "plan", label: "Study plan", count: plan.study_plan.length },
          ]}
        />

        {tab === "description" && (
          <TabPanel id="description">
            <div className="grid gap-8 md:grid-cols-2">
              <Section title="What you'd be doing" items={job.responsibilities} />
              <div className="space-y-8">
                <Section title="What they require" items={job.requirements} />
                <Section title="Nice to have" items={job.nice_to_have} />
              </div>
            </div>
            {job.tech_stack.length > 0 && (
              <div className="mt-8">
                <h3 className="mb-3 text-sm font-semibold text-ink">Tech stack</h3>
                <div className="flex flex-wrap gap-2">
                  {job.tech_stack.map((t) => (
                    <code key={t} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink">
                      {t}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {job.benefits.length > 0 && (
              <div className="mt-8">
                <Section title="Benefits" items={job.benefits} />
              </div>
            )}
          </TabPanel>
        )}

        {tab === "skills" && (
          <TabPanel id="skills">
            <CardHeader icon="tag" title="Key skills" />
            {plan.key_skills.length ? (
              <div className="flex flex-wrap gap-2">
                {plan.key_skills.map((s) => (
                  <span key={s} className="rounded-full border border-accent/25 bg-accent-soft px-3 py-1 text-sm text-ink">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <Empty what="key skills" />
            )}
            <p className="mt-4 text-xs text-ink-3">Taken word-for-word from the posting — nothing inferred, ranked or added.</p>
          </TabPanel>
        )}

        {tab === "topics" && (
          <TabPanel id="topics">
            <CardHeader icon="chat" title="Likely interview topics" />
            {plan.interview_topics.length ? <BulletList items={plan.interview_topics} /> : <Empty what="likely interview topics" />}
          </TabPanel>
        )}

        {tab === "plan" && (
          <TabPanel id="plan">
            <CardHeader icon="plan" title="Study plan" />
            {plan.study_plan.length ? (
              <NumberedList items={plan.study_plan.map((s) => ({ heading: s.strategy, description: s.description }))} />
            ) : (
              <Empty what="study plan" />
            )}
          </TabPanel>
        )}
      </Card>

      {/* -- next step --------------------------------------------------- */}
      <Card className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-ink">Ready to practise?</h2>
          <p className="mt-1 text-sm text-ink-2">
            A mock interview for this role: you choose the length, it opens with a self-introduction, then splits the
            rest between technical and behavioural questions. Every answer is scored and rewritten at the end.
          </p>
          {declined && (
            <p className="mt-3 text-sm text-ink-2" role="status">
              No problem — the plan stays here. Use <span className="font-medium text-ink">Start over</span> for another
              role.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row">
          {!declined && (
            <Button variant="ghost" onClick={() => setDeclined(true)}>
              Not now
            </Button>
          )}
          <Button variant="primary" size="lg" iconRight="arrowRight" onClick={() => dispatch({ type: "goto", stage: "interview_setup" })}>
            Start a mock interview
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>
      <BulletList items={items} />
    </div>
  );
}

function Empty({ what }: { what: string }) {
  return <p className="text-sm text-ink-3">No {what} found in this posting.</p>;
}
