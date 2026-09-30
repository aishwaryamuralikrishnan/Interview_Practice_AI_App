/**
 * scraper.ts — steps 1–2 of the workflow.
 *
 * Fetches a job-posting URL, reduces the HTML to readable text, and hands that
 * text to the model for structured extraction.
 *
 * Plain HTTP fetching cannot get past LinkedIn/Indeed/Glassdoor logins or
 * JavaScript-only pages. Rather than pretending otherwise, fetchPostingText()
 * returns a FetchResult whose `ok` flag tells the UI to show the "paste the
 * posting instead" box.
 *
 * Ported from job_scraper.py. HTML parsing uses cheerio in htmlparser2 mode,
 * the closest match to BeautifulSoup's "html.parser": neither invents
 * <html>/<body> wrappers the page didn't have, which matters because the
 * extraction falls back to "the body, or else the whole document".
 */

import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import * as config from "./config";
import { BlockedAddressError, guardedFetch } from "./server/netguard";
import { toPromptText, type JobDescription, type PrepPlan, type StudyStrategy } from "./job";
import type { ChatClient, ChatMessage, JsonObject } from "./llm";
import * as prompts from "./prompts";
import {
  cpLen,
  cpSlice,
  PY_WS_CLASS,
  pyCollapse,
  pyFormat,
  pyOr,
  pySplitlines,
  pyStr,
  pyStrip,
  pyStripChars,
  pyTruthy,
} from "./py";

export * from "./job";

// Page furniture that is never part of a job posting.
const STRIP_TAGS = [
  "script", "style", "noscript", "svg", "canvas", "iframe",
  "nav", "header", "footer", "form", "button", "aside",
];

// Containers that usually hold the posting itself, tried in order.
const MAIN_SELECTORS = [
  "[class*='job-description']",
  "[id*='job-description']",
  "[class*='jobDescription']",
  "[data-testid*='jobDescription']",
  "article",
  "main",
  "[role='main']",
  "#content",
  ".content",
];

export interface FetchResult {
  ok: boolean;
  text: string;
  url: string;
  status_code: number | null;
  error: string;
  hint: string;
}

function fetchResult(partial: Partial<FetchResult> & { ok: boolean }): FetchResult {
  return { text: "", url: "", status_code: null, error: "", hint: "", ...partial };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function normaliseUrl(url: string): string {
  let u = pyStrip(url ?? "");
  if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

/**
 * The scheme and network location, split the way Python's urlparse() does —
 * without validating them. (WHATWG `new URL()` is stricter and would reject
 * inputs the Python version accepted.)
 */
function urlSplit(url: string): { scheme: string; netloc: string } {
  let rest = url;
  let scheme = "";
  const colon = rest.indexOf(":");
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+\-.]*$/.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const end = after.search(/[/?#]/);
    netloc = end === -1 ? after : after.slice(0, end);
  }
  return { scheme, netloc };
}

export function isValidUrl(url: string): boolean {
  const { scheme, netloc } = urlSplit(normaliseUrl(url));
  return (scheme === "http" || scheme === "https") && netloc !== "" && netloc.includes(".");
}

/**
 * The known-blocking domain this URL belongs to, if any.
 *
 * Deliberate difference from the Python: it compares the *hostname*, so
 * "linkedin.com:443" or "me@linkedin.com" is still recognised. The Python
 * compared the raw netloc, port and user-info included.
 */
export function blockedDomain(url: string): string | null {
  const { netloc } = urlSplit(url);
  const host = netloc.toLowerCase().replace(/^.*@/, "").replace(/:\d*$/, "");
  for (const domain of config.KNOWN_BLOCKED_DOMAINS) {
    if (host === domain || host.endsWith("." + domain)) return domain;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The guard's refusal — thrown directly, or wrapped by fetch as the cause of "fetch failed". */
function isBlocked(exc: unknown): boolean {
  const cause = (exc as { cause?: unknown } | null)?.cause;
  return exc instanceof BlockedAddressError || cause instanceof BlockedAddressError || (cause as { code?: string } | undefined)?.code === "EBLOCKED";
}

/**
 * Decode a page the way a browser would: the charset in the Content-Type
 * header, else a <meta charset> in the first 2 KB, else UTF-8.
 *
 * Deliberate difference from the Python: `requests` decodes any text/html
 * response that omits a charset as ISO-8859-1, which turns "Aufgaben für"
 * into "Aufgaben fÃ¼r" on some German career sites.
 */
function decodeBody(bytes: ArrayBuffer, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // unknown label — try the next
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function isTimeout(exc: unknown): boolean {
  return exc instanceof Error && (exc.name === "TimeoutError" || exc.name === "AbortError");
}

function describeError(exc: unknown): string {
  if (exc instanceof Error) {
    const cause = (exc as Error & { cause?: unknown }).cause;
    return cause instanceof Error && cause.message ? cause.message : exc.message;
  }
  return String(exc);
}

/**
 * Download a posting URL and return its readable text.
 *
 * The default fetch is guardedFetch (lib/server/netguard.ts): it refuses
 * private, loopback and link-local addresses at every redirect hop and on the
 * connection itself, so a link cannot make the server fetch internal
 * addresses (SSRF). Tests inject their own fetchImpl.
 */
export async function fetchPostingText(
  url: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<FetchResult> {
  const doFetch = options.fetchImpl ?? guardedFetch;
  url = normaliseUrl(url);

  if (!isValidUrl(url)) {
    return fetchResult({
      ok: false,
      url,
      error: "That doesn't look like a valid web address.",
      hint: "Include the full link, e.g. https://careers.example.com/jobs/1234",
    });
  }

  const blocked = blockedDomain(url);
  if (blocked) {
    return fetchResult({
      ok: false,
      url,
      error: `${blocked} blocks automated page fetches, so the posting can't be read from the link.`,
      hint: "Open the posting in your browser, select the description, and paste it below.",
    });
  }

  let response: Response;
  let body: string;
  try {
    response = await doFetch(url, {
      headers: config.SCRAPER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(config.SCRAPER_TIMEOUT_SECONDS * 1000),
    });
    body = decodeBody(await response.arrayBuffer(), response.headers.get("content-type"));
  } catch (exc) {
    if (isBlocked(exc)) {
      return fetchResult({
        ok: false,
        url,
        error: "That link points to a private or local network address, so it can't be fetched.",
        hint: "Use the public link to the posting, or paste its text below instead.",
      });
    }
    if (isTimeout(exc)) {
      return fetchResult({
        ok: false,
        url,
        error: "The site took too long to respond.",
        hint: "Paste the posting text below instead.",
      });
    }
    return fetchResult({
      ok: false,
      url,
      error: `Could not reach the page: ${describeError(exc)}`,
      hint: "Paste the posting text below instead.",
    });
  }

  if (response.status >= 400) {
    return fetchResult({
      ok: false,
      url,
      status_code: response.status,
      error: `The site returned HTTP ${response.status}.`,
      hint: "Many job boards block non-browser requests. Paste the posting text below instead.",
    });
  }

  const text = htmlToText(body);

  if (cpLen(text) < 300) {
    return fetchResult({
      ok: false,
      url,
      status_code: response.status,
      text,
      error: "The page loaded but contained almost no text — it is most likely rendered by JavaScript.",
      hint: "Paste the posting text below instead.",
    });
  }

  return fetchResult({ ok: true, text, url, status_code: response.status });
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

/** Every text node under `node`, in document order — BeautifulSoup's strings. */
function textNodes(node: AnyNode, out: string[] = []): string[] {
  if (node.type === "text") {
    out.push((node as unknown as { data: string }).data);
  } else if ("children" in node && Array.isArray((node as { children?: AnyNode[] }).children)) {
    for (const child of (node as unknown as { children: AnyNode[] }).children) textNodes(child, out);
  }
  return out;
}

function getText(nodes: AnyNode[], separator: string, strip: boolean): string {
  let strings: string[] = [];
  for (const n of nodes) textNodes(n, strings);
  if (strip) strings = strings.map(pyStrip).filter((s) => s !== "");
  return strings.join(separator);
}

/** Strip a page down to the readable text most likely to be the posting. */
export function htmlToText(html: string): string {
  const $: CheerioAPI = load(html, { xml: { xmlMode: false, decodeEntities: true } });

  $(STRIP_TAGS.join(",")).remove();

  let container: AnyNode[] | null = null;
  for (const selector of MAIN_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length && cpLen(getText(candidate.toArray(), "", true)) > 400) {
      container = candidate.toArray();
      break;
    }
  }
  if (!container) {
    const body = $("body").first();
    container = body.length ? body.toArray() : $.root().toArray();
  }

  const text = getText(container, "\n", false);

  const lines: string[] = [];
  let previousBlank = false;
  for (const rawLine of pySplitlines(text)) {
    const line = pyCollapse(rawLine);
    if (!line) {
      if (!previousBlank && lines.length) lines.push("");
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    lines.push(line);
  }

  const cleaned = pyStrip(lines.join("\n"));
  return cpSlice(cleaned, config.MAX_JOB_TEXT_CHARS);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Python's `for entry in value or []`, for JSON-shaped values. */
export function pyIter(value: unknown): unknown[] {
  if (!pyTruthy(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (typeof value === "object") return Object.keys(value as object);
  const typeName = typeof value === "number" ? (Number.isInteger(value) ? "int" : "float") : "bool";
  throw new TypeError(`'${typeName}' object is not iterable`);
}

const BULLET_SPLIT = new RegExp(`[\\r\\n]+|(?:(?<=[${PY_WS_CLASS}])|^)[•▪·][${PY_WS_CLASS}]+`, "u");
const BULLET_PREFIX = new RegExp(`^[-*•▪·\\u2013\\u2014][${PY_WS_CLASS}]+`, "u");

/**
 * Normalise a list field, recovering bullets a weaker model merged.
 *
 * Smaller models (gpt-5-nano especially) sometimes return a bullet list as
 * one newline-separated string, or as one array item containing several
 * bullets. Splitting on line breaks and bullet glyphs puts the structure
 * back; a genuine single paragraph has neither and is left alone.
 */
function asList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const items: string[] = [];
  for (const entry of raw) {
    const text = pyStrip(pyStr(pyOr(entry, "")));
    if (!text) continue;
    for (const piece of text.split(BULLET_SPLIT)) {
      const line = pyStrip(pyStrip(piece ?? "").replace(BULLET_PREFIX, ""));
      if (line) items.push(line);
    }
  }
  return items;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = pyStrip(pyStr(value));
  return text || null;
}

function getOr(data: JsonObject, key: string, fallback: unknown): unknown {
  return Object.hasOwn(data, key) ? data[key] : fallback;
}

export function extractionMessages(
  pageText: string,
  translate: boolean = config.TRANSLATE_JOB_DESCRIPTION,
): ChatMessage[] {
  const translationInstruction = translate
    ? pyFormat(prompts.JOB_TRANSLATION_INSTRUCTION, { display_language: config.DISPLAY_LANGUAGE })
    : prompts.NO_TRANSLATION_INSTRUCTION;
  return [
    {
      role: "system",
      content: pyFormat(prompts.JOB_EXTRACTION_SYSTEM, { translation_instruction: translationInstruction }),
    },
    { role: "user", content: pyFormat(prompts.JOB_EXTRACTION_USER, { page_text: pageText }) },
  ];
}

/** Turn raw posting text into a structured JobDescription via the model. */
export async function extractJobDescription(
  client: ChatClient,
  pageText: string,
  sourceUrl = "",
  options: { translate?: boolean } = {},
): Promise<JobDescription> {
  const text = cpSlice(pyStrip(pageText ?? ""), config.MAX_JOB_TEXT_CHARS);
  const data = await client.chatJson(extractionMessages(text, options.translate), "job_extraction");

  return {
    raw_text: text,
    source_url: sourceUrl,
    is_job_posting: pyTruthy(getOr(data, "is_job_posting", true)),
    extraction_note: asText(data.extraction_note),
    injection_notice: asText(data.injection_notice),
    job_title: asText(data.job_title),
    company: asText(data.company),
    location: asText(data.location),
    employment_type: asText(data.employment_type),
    seniority: asText(data.seniority),
    language_of_posting: asText(data.language_of_posting),
    was_translated: pyTruthy(getOr(data, "was_translated", false)),
    summary: asText(data.summary) || "",
    responsibilities: asList(data.responsibilities),
    requirements: asList(data.requirements),
    nice_to_have: asList(data.nice_to_have),
    tech_stack: asList(data.tech_stack),
    benefits: asList(data.benefits),
    original_description: asText(data.original_description) || "",
    original_responsibilities: asList(data.original_responsibilities),
    original_requirements: asList(data.original_requirements),
  };
}

/**
 * Accept a list of strings, or of dicts, and end up with strings.
 *
 * Older prompt versions — and an occasionally creative model — return
 * [{"skill": "SQL"}] instead of ["SQL"]. Flatten rather than crash.
 */
function asPhrases(value: unknown): string[] {
  const items: string[] = [];
  for (const entry of pyIter(value)) {
    let text: string;
    if (typeof entry === "string") {
      text = entry;
    } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as JsonObject;
      const key = ["skill", "topic", "name", "keyword", "title"].find((k) => pyTruthy(obj[k]));
      text = key ? pyStr(obj[key]) : "";
    } else {
      text = pyStr(entry);
    }
    text = pyStripChars(text, " .;,");
    if (text) items.push(text);
  }
  return items;
}

export function prepPlanMessages(job: JobDescription): ChatMessage[] {
  return [
    { role: "system", content: prompts.PREP_PLAN_SYSTEM },
    {
      role: "user",
      content: pyFormat(prompts.PREP_PLAN_USER, {
        job_description: toPromptText(job),
        max_key_skills: config.MAX_KEY_SKILLS,
        max_interview_topics: config.MAX_INTERVIEW_TOPICS,
        num_study_strategies: config.NUM_STUDY_STRATEGIES,
      }),
    },
  ];
}

/**
 * Step 3 — key skills, likely interview topics, and a study plan.
 *
 * The caps in config are enforced here as well as in the prompt: a model that
 * returns fifteen topics must not be able to break the card layout.
 */
export async function buildPrepPlan(client: ChatClient, job: JobDescription): Promise<PrepPlan> {
  const data = await client.chatJson(prepPlanMessages(job), "prep_plan");

  const strategies: StudyStrategy[] = [];
  for (const entry of pyIter(data.study_plan)) {
    let strategy: string;
    let description: string;
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as JsonObject;
      strategy = pyStrip(pyStr(pyOr(obj.strategy, pyOr(obj.focus, ""))));
      description = pyStrip(pyStr(pyOr(obj.description, "")));
    } else {
      strategy = pyStrip(pyStr(entry));
      description = "";
    }
    if (strategy || description) {
      // One line means one line, whatever the model sent.
      strategies.push({ strategy, description: pyCollapse(description) });
    }
  }

  return {
    key_skills: asPhrases(data.key_skills).slice(0, config.MAX_KEY_SKILLS),
    interview_topics: asPhrases(data.interview_topics).slice(0, config.MAX_INTERVIEW_TOPICS),
    study_plan: strategies.slice(0, config.NUM_STUDY_STRATEGIES),
  };
}
