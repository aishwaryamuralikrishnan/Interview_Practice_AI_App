/**
 * POST /api/report — the finished interview in, a PDF out.
 *
 * No model call and no key needed: everything in the report is already in
 * the browser. It is rendered on the server only because the PDF library and
 * its embedded fonts are too heavy to ship to every visitor.
 */

import { buildQuestionPlan, isComplete } from "../interview";
import { buildReport, suggestedFilename } from "../server/report";
import { InputError, parseModelSettings } from "./settings";
import { parseInterviewSettings, parseJob, parseSummary, parseTimeZone, parseTranscript } from "./validate";

export type ReportResult =
  | { status: 200; pdf: Buffer; filename: string }
  | { status: 400 | 409; body: { ok: false; stage: "input" | "state"; error: string } };

export async function handleReportRequest(input: unknown, now = new Date()): Promise<ReportResult> {
  const bad = (error: string) => ({ status: 400 as const, body: { ok: false as const, stage: "input" as const, error } });
  if (input === null || typeof input !== "object" || Array.isArray(input)) return bad("The request body must be a JSON object.");
  const req = input as Record<string, unknown>;

  let parsed;
  try {
    const job = parseJob(req.job);
    const interview = parseInterviewSettings(req.interview);
    parsed = {
      job,
      interview,
      transcript: parseTranscript(req.transcript, buildQuestionPlan(interview)),
      summary: parseSummary(req.summary),
      modelSettings: req.settings === undefined ? null : parseModelSettings(req.settings),
      timeZone: parseTimeZone(req.timeZone),
    };
  } catch (exc) {
    if (exc instanceof InputError) return bad(exc.message);
    throw exc;
  }

  if (!isComplete(parsed.transcript, parsed.interview) || parsed.transcript.some((t) => !t.evaluation)) {
    return { status: 409, body: { ok: false, stage: "state", error: "The report needs a finished, scored interview." } };
  }

  const pdf = await buildReport({ ...parsed, generatedAt: now });
  return { status: 200, pdf, filename: suggestedFilename(parsed.job, now, parsed.timeZone) };
}
