/**
 * Stage 1 → 2 as one request: a job link (or pasted text) in, a structured
 * posting and a preparation plan out. Two model calls.
 *
 * Mirrors process_posting() in the Streamlit app, failure for failure:
 * fetch or paste → a 120-character minimum for pasted text → extraction →
 * reject a page that isn't a posting, using the model's own note → the plan.
 *
 * Kept free of Next.js so it can be tested directly: the Route Handler in
 * app/api/job/route.ts only supplies a real client and turns the result into
 * a Response.
 */

import type { ChatClient, ModelSettings } from "../llm";
import { LLMError, Usage } from "../llm";
import { cpLen, pyStrip } from "../py";
import {
  buildPrepPlan,
  extractJobDescription,
  fetchPostingText,
  type FetchResult,
  type JobDescription,
  type PrepPlan,
} from "../scraper";
import { InputError, parseModelSettings } from "./settings";

import { MIN_PASTED_CHARS } from "../config";

export { MIN_PASTED_CHARS };

export type JobResponse =
  | { ok: true; source: "url" | "text"; job: JobDescription; plan: PrepPlan; usage: ReturnType<Usage["toJSON"]> }
  | { ok: false; stage: "input" | "fetch" | "config" | "model" | "not_a_posting"; error: string; hint?: string; fetch?: FetchResult };

export interface JobDeps {
  makeClient: (settings: ModelSettings) => ChatClient & { usage: Usage };
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

function fail(status: number, body: Extract<JobResponse, { ok: false }>) {
  return { status, body };
}

export async function handleJobRequest(input: unknown, deps: JobDeps): Promise<{ status: number; body: JobResponse }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return fail(400, { ok: false, stage: "input", error: "Send a JSON object with either `url` or `text`." });
  }
  const req = input as Record<string, unknown>;
  const url = typeof req.url === "string" ? req.url : "";
  const text = typeof req.text === "string" ? req.text : "";

  let settings: ModelSettings;
  try {
    settings = parseModelSettings(req.settings);
  } catch (exc) {
    if (exc instanceof InputError) return fail(400, { ok: false, stage: "input", error: exc.message });
    throw exc;
  }

  // Pasted text wins when both are given, exactly as the "Use this text"
  // button did; the link is kept as the source.
  let pageText: string;
  let sourceUrl: string;
  let source: "url" | "text";
  if (pyStrip(text)) {
    if (cpLen(pyStrip(text)) < MIN_PASTED_CHARS) {
      return fail(422, {
        ok: false,
        stage: "input",
        error: "That's very short — paste the full posting so the questions can be specific.",
      });
    }
    pageText = text;
    sourceUrl = url;
    source = "text";
  } else if (pyStrip(url)) {
    const fetched = await fetchPostingText(url, { fetchImpl: deps.fetchImpl });
    if (!fetched.ok) {
      return fail(422, { ok: false, stage: "fetch", error: fetched.error, hint: fetched.hint, fetch: fetched });
    }
    pageText = fetched.text;
    sourceUrl = fetched.url;
    source = "url";
  } else {
    return fail(400, { ok: false, stage: "input", error: "Give a link to the posting, or paste its text." });
  }

  let client: ChatClient & { usage: Usage };
  try {
    client = deps.makeClient(settings);
  } catch (exc) {
    if (exc instanceof LLMError) return fail(500, { ok: false, stage: "config", error: exc.message });
    throw exc;
  }

  let job: JobDescription;
  try {
    job = await extractJobDescription(client, pageText, sourceUrl);
  } catch (exc) {
    if (exc instanceof LLMError) return fail(502, { ok: false, stage: "model", error: exc.message });
    throw exc;
  }

  if (!job.is_job_posting) {
    return fail(422, {
      ok: false,
      stage: "not_a_posting",
      error: "That page doesn't look like a job posting. " + (job.extraction_note || "Try a direct link to the posting itself."),
    });
  }

  let plan: PrepPlan;
  try {
    plan = await buildPrepPlan(client, job);
  } catch (exc) {
    if (exc instanceof LLMError) return fail(502, { ok: false, stage: "model", error: exc.message });
    throw exc;
  }

  return { status: 200, body: { ok: true, source, job, plan, usage: client.usage.toJSON() } };
}
