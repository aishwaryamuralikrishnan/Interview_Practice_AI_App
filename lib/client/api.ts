/**
 * The browser's side of the four Route Handlers. Types only are imported from
 * the server modules, so nothing server-side is bundled into the page.
 *
 * Every call resolves — it never throws. A dropped connection or a host that
 * answers with an HTML error page becomes the same `{ ok: false }` shape the
 * endpoints use, so the UI has one error path.
 */

import type { EvaluateResponse, QuestionResponse, SummaryResponse, UsageJSON } from "../api/interview";
import type { OverallSummary } from "../evaluation";
import type { JobResponse } from "../api/job";
import type { InterviewSettings, TurnRecord } from "../interview";
import type { ModelSettings } from "../llm";
import type { JobDescription } from "../job";

export type NetworkFailure = { ok: false; stage: "network"; error: string };

/** Refusals by lib/server/access.ts, which can come from any endpoint. */
export type GuardFailure = { ok: false; stage: "auth" | "rate_limit"; error: string };

/** Fired when the server wants the access code (again); the app shows the gate. */
export const AUTH_REQUIRED_EVENT = "ipa:auth-required";

function noticeAuth(status: number, body: unknown) {
  if (status === 401 && (body as { stage?: string } | null)?.stage === "auth") {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | NetworkFailure | GuardFailure> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (exc) {
    if ((exc as Error).name === "AbortError") throw exc;
    return { ok: false, stage: "network", error: "Couldn't reach the app's server. Check it is still running, then try again." };
  }
  try {
    const parsed = (await response.json()) as T;
    noticeAuth(response.status, parsed);
    return parsed;
  } catch {
    return {
      ok: false,
      stage: "network",
      error: `The server answered with an unexpected response (HTTP ${response.status}). Try again.`,
    };
  }
}

export function fetchJob(input: { url: string; text: string; settings: ModelSettings }) {
  return post<JobResponse>("/api/job", input);
}

export interface InterviewContext {
  job: JobDescription;
  interview: InterviewSettings;
  settings: ModelSettings;
}

export function fetchQuestion(ctx: InterviewContext, transcript: TurnRecord[]) {
  return post<QuestionResponse>("/api/question", { ...ctx, transcript });
}

export function fetchEvaluation(ctx: InterviewContext, turn: TurnRecord) {
  return post<EvaluateResponse>("/api/evaluate", { ...ctx, turn });
}

export function fetchSummary(ctx: InterviewContext, transcript: TurnRecord[]) {
  return post<SummaryResponse>("/api/summary", { ...ctx, transcript });
}

// ---------------------------------------------------------------------------
// Token usage, summed across requests — each request reports its own.
// ---------------------------------------------------------------------------

export type UsageTotals = UsageJSON;

export const EMPTY_USAGE: UsageTotals = {
  prompt_tokens: 0,
  completion_tokens: 0,
  reasoning_tokens: 0,
  calls: 0,
  peak_completion_tokens: 0,
  total_tokens: 0,
};

export function addUsage(a: UsageTotals, b: UsageJSON | undefined): UsageTotals {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    calls: a.calls + b.calls,
    peak_completion_tokens: Math.max(a.peak_completion_tokens, b.peak_completion_tokens),
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

// ---------------------------------------------------------------------------
// The PDF report — the one endpoint that answers with a file, not JSON.
// ---------------------------------------------------------------------------

export interface ReportRequest extends InterviewContext {
  transcript: TurnRecord[];
  summary: OverallSummary | null;
}

export async function fetchReport(
  req: ReportRequest,
): Promise<{ ok: true; blob: Blob; filename: string } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the app's server. Check it is still running, then try again." };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    noticeAuth(response.status, body);
    return { ok: false, error: body?.error ?? `The report couldn't be built (HTTP ${response.status}).` };
  }
  const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  return { ok: true, blob: await response.blob(), filename: match?.[1] ?? "interview-report.pdf" };
}

/** Hand a file to the browser's download. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// The access code (only when the server has one configured)
// ---------------------------------------------------------------------------

export async function fetchSession(): Promise<{ required: boolean; authorised: boolean }> {
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    return (await response.json()) as { required: boolean; authorised: boolean };
  } catch {
    // If the check itself fails, let the app load; any API call will ask again.
    return { required: false, authorised: true };
  }
}

export async function login(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    return response.ok && body?.ok ? { ok: true } : { ok: false, error: body?.error ?? "That didn't work. Try again." };
  } catch {
    return { ok: false, error: "Couldn't reach the app's server. Try again." };
  }
}
