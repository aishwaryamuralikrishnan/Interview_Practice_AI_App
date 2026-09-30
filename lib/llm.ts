/**
 * llm.ts — thin wrapper around the OpenRouter chat API.
 *
 * The rest of the app never builds an HTTP request itself; it calls
 * `client.chat(...)` or `client.chatJson(...)` with a *profile name* from
 * config.MODEL_PROFILES. That keeps every model parameter in config.ts and
 * every prompt string in prompts.ts.
 *
 * This module never reads the API key. The caller passes it in, and the only
 * caller that does so is lib/server/openrouter.ts, which is marked
 * server-only — so the key cannot end up in a browser bundle even by mistake.
 * Taking `fetch` and `sleep` as parameters is what lets the tests drive the
 * retry logic with no network and no waiting.
 *
 * Ported from llm_client.py.
 */

import * as config from "./config";
import type { ModelProfile, ProfileName, ReasoningEffort } from "./config";
import { cpSlice, PY_WS_CLASS, pyOr, pyStr, pyStrip, pyTruthy } from "./py";

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type JsonObject = Record<string, unknown>;

/** What any chat client — real or stubbed — must provide. */
export interface ChatClient {
  chat(messages: ChatMessage[], profile: ProfileName, options?: ChatOptions): Promise<string>;
  chatJson(messages: ChatMessage[], profile: ProfileName, options?: { maxTokensOverride?: number | null }): Promise<JsonObject>;
}

export interface ChatOptions {
  jsonMode?: boolean;
  maxTokensOverride?: number | null;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function asCount(value: unknown): number {
  const v = pyOr(value, 0);
  return typeof v === "number" ? v : 0;
}

/** Rolling token counter, handy while tuning prompts. */
export class Usage {
  prompt_tokens = 0;
  completion_tokens = 0;
  reasoning_tokens = 0;
  calls = 0;
  /**
   * The largest single completion seen. The right way to choose max_tokens is
   * to watch this over a few real runs rather than guess.
   */
  peak_completion_tokens = 0;

  add(payload: unknown): void {
    const p = (pyOr(payload, {}) as JsonObject) ?? {};
    const usage = (pyOr(p.usage, {}) as JsonObject) ?? {};
    this.prompt_tokens += asCount(usage.prompt_tokens);
    this.completion_tokens += asCount(usage.completion_tokens);
    const details = (pyOr(usage.completion_tokens_details, {}) as JsonObject) ?? {};
    this.reasoning_tokens += asCount(details.reasoning_tokens);
    this.peak_completion_tokens = Math.max(this.peak_completion_tokens, asCount(usage.completion_tokens));
    this.calls += 1;
  }

  get total_tokens(): number {
    return this.prompt_tokens + this.completion_tokens;
  }

  toJSON() {
    return {
      prompt_tokens: this.prompt_tokens,
      completion_tokens: this.completion_tokens,
      reasoning_tokens: this.reasoning_tokens,
      calls: this.calls,
      peak_completion_tokens: this.peak_completion_tokens,
      total_tokens: this.total_tokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Model settings — what the USER chose in step 1
// ---------------------------------------------------------------------------

/**
 * These override the per-task defaults in config.MODEL_PROFILES for every
 * call. `temperature` is only ever sent to a model whose MODEL_CHOICES entry
 * says it accepts sampling parameters — no GPT-5 model does.
 *
 * A plain object rather than a class, so it can cross the network between
 * the browser and a Route Handler unchanged.
 */
export interface ModelSettings {
  model: string;
  reasoning_effort: ReasoningEffort | "";
  max_tokens: number;
  temperature: number;
  seed: number | null;
}

export function defaultModelSettings(overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    model: config.DEFAULT_MODEL,
    reasoning_effort: config.DEFAULT_REASONING_EFFORT,
    max_tokens: config.DEFAULT_MAX_TOKENS,
    temperature: config.DEFAULT_TEMPERATURE,
    seed: null,
    ...overrides,
  };
}

export function settingsSupportSampling(settings: ModelSettings): boolean {
  return config.modelSupportsSampling(settings.model);
}

export function modelLabel(settings: ModelSettings): string {
  return config.MODEL_CHOICES[settings.model]?.label ?? settings.model;
}

/** Rough USD for one full session at this length, for the UI estimate. */
export function estimatedCost(settings: ModelSettings, numQuestions: number): number {
  const spec = config.MODEL_CHOICES[settings.model];
  if (!spec) return 0.0;
  const inputTokens = config.EST_INPUT_TOKENS_BASE + config.EST_INPUT_TOKENS_PER_QUESTION * numQuestions;
  const outputTokens = config.EST_OUTPUT_TOKENS_BASE + config.EST_OUTPUT_TOKENS_PER_QUESTION * numQuestions;
  return (inputTokens * spec.price_in + outputTokens * spec.price_out) / 1_000_000;
}

export function settingsAsDict(settings: ModelSettings): JsonObject {
  const data: JsonObject = {
    model: settings.model,
    reasoning_effort: settings.reasoning_effort,
    max_tokens: settings.max_tokens,
    seed: settings.seed,
  };
  if (settingsSupportSampling(settings)) data.temperature = settings.temperature;
  return data;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LLMClientOptions {
  apiKey: string;
  /** The user's step-1 choices. null = use the per-task profiles as defined. */
  settings?: ModelSettings | null;
  fetchImpl?: FetchLike;
  /** Milliseconds. Injected so tests don't wait for real back-off. */
  sleep?: (ms: number) => Promise<void>;
}

const SAMPLING_KEYS = ["temperature", "top_p", "frequency_penalty", "presence_penalty"] as const;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LLMClient implements ChatClient {
  readonly usage = new Usage();
  settings: ModelSettings | null;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LLMClientOptions) {
    const key = pyStrip(options.apiKey ?? "");
    if (!key) {
      throw new LLMError(
        `No API key found. Set ${config.API_KEY_ENV_VAR} in a .env.local file ` +
          "in the project root (or in your environment) and restart the dev server.",
      );
    }
    this.apiKey = key;
    this.settings = options.settings ?? null;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? realSleep;
  }

  // -- public API -----------------------------------------------------------

  /** Send a chat completion and return the assistant's text. */
  async chat(messages: ChatMessage[], profile: ProfileName, options: ChatOptions = {}): Promise<string> {
    const jsonMode = options.jsonMode ?? false;
    const override = options.maxTokensOverride ?? null;
    const profileSettings = config.MODEL_PROFILES[profile];
    const body = this.buildBody(profileSettings, messages, jsonMode, override);
    const payload = await this.postWithRetries(body, jsonMode);
    this.usage.add(payload);
    return LLMClient.extractText(payload);
  }

  /** Send a chat completion that must return a JSON object, and parse it. */
  async chatJson(
    messages: ChatMessage[],
    profile: ProfileName,
    options: { maxTokensOverride?: number | null } = {},
  ): Promise<JsonObject> {
    const raw = await this.chat(messages, profile, { jsonMode: true, maxTokensOverride: options.maxTokensOverride });
    return parseJsonObject(raw);
  }

  // -- internals ------------------------------------------------------------

  buildBody(
    profile: ModelProfile,
    messages: ChatMessage[],
    jsonMode: boolean,
    maxTokensOverride: number | null,
  ): JsonObject {
    const chosen = this.settings;

    const model = chosen ? chosen.model : profile.model;
    const effort = chosen ? chosen.reasoning_effort : profile.reasoning_effort;
    const maxTokens =
      maxTokensOverride || (chosen ? chosen.max_tokens : "max_tokens" in profile ? profile.max_tokens : 4000);

    const body: JsonObject = { model, messages, max_tokens: maxTokens };

    if (pyTruthy(effort)) body.reasoning = { effort };

    if (chosen !== null && chosen.seed !== null && chosen.seed !== undefined) body.seed = chosen.seed;

    // Sent ONLY to a model that accepts them. Every GPT-5 model returns 400 for
    // temperature/top_p — OpenRouter does not list them among its
    // supported_parameters. See config.MODEL_CHOICES.
    if (config.modelSupportsSampling(model)) {
      if (chosen !== null) {
        body.temperature = chosen.temperature;
      } else {
        for (const key of SAMPLING_KEYS) {
          if (key in profile) body[key] = profile[key];
        }
      }
    }

    if (jsonMode) body.response_format = { type: "json_object" };

    return body;
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (config.OPENROUTER_APP_URL) headers["HTTP-Referer"] = config.OPENROUTER_APP_URL;
    if (config.OPENROUTER_APP_TITLE) headers["X-Title"] = config.OPENROUTER_APP_TITLE;
    return headers;
  }

  private async postWithRetries(initialBody: JsonObject, initialJsonMode: boolean): Promise<JsonObject> {
    const url = `${config.API_BASE_URL}/chat/completions`;
    let body = initialBody;
    let jsonMode = initialJsonMode;
    let backoff = config.RETRY_BACKOFF_SECONDS;
    let lastError = "";

    for (let attempt = 0; attempt < config.MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_SECONDS * 1000),
        });
      } catch (exc) {
        lastError = `Network error: ${describeError(exc)}`;
        await this.sleep(backoff * 1000);
        backoff *= 2;
        continue;
      }

      if (response.status === 200) {
        try {
          return (await response.json()) as JsonObject;
        } catch {
          throw new LLMError("The API returned a response that was not JSON.");
        }
      }

      const detail = await errorDetail(response);

      // A model that doesn't support JSON mode, or a rejected sampling
      // parameter, is permanent — retrying the same body is pointless. Strip
      // the offending field once and try again.
      if (response.status === 400) {
        if (jsonMode && "response_format" in body && mentions(detail, "response_format", "json")) {
          body = { ...body };
          delete body.response_format;
          jsonMode = false;
          continue;
        }
        if ("reasoning" in body && mentions(detail, "reasoning")) {
          body = { ...body };
          delete body.reasoning;
          continue;
        }
        if (mentions(detail, "temperature", "top_p")) {
          body = { ...body };
          for (const key of SAMPLING_KEYS) delete body[key];
          continue;
        }
        throw new LLMError(`The API rejected the request (400): ${detail}`);
      }

      if (response.status === 401 || response.status === 403) {
        throw new LLMError(
          `Authentication failed (${response.status}). Check that ` +
            `${config.API_KEY_ENV_VAR} holds a valid OpenRouter key with ` +
            `credit available. Details: ${detail}`,
        );
      }

      if (response.status === 402) {
        throw new LLMError(`OpenRouter reports insufficient credit: ${detail}`);
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}: ${detail}`;
        await this.sleep(backoff * 1000);
        backoff *= 2;
        continue;
      }

      throw new LLMError(`HTTP ${response.status}: ${detail}`);
    }

    throw new LLMError(
      `The model could not be reached after ${config.MAX_RETRIES} attempts. ` + `Last error — ${lastError}`,
    );
  }

  static extractText(payload: JsonObject): string {
    const choices = pyOr(payload.choices, []) as unknown[];
    if (!Array.isArray(choices) || choices.length === 0) {
      const error = (pyOr(payload.error, {}) as JsonObject) ?? {};
      const message = "message" in error ? pyStr(error.message) : "";
      throw new LLMError(pyStrip(`The model returned no choices. ${message}`));
    }

    const choice = choices[0] as JsonObject;
    const message = (pyOr(choice.message, {}) as JsonObject) ?? {};
    const text = pyStrip(pyStr(pyOr(message.content, "")));

    // OpenRouter: at the cap, "generation simply stops" and whatever was
    // produced so far comes back. That is never usable here — a truncated
    // question or a half-written JSON object is worse than a clear error, so
    // treat it as a failure whether or not any text arrived.
    if (choice.finish_reason === "length") {
      if (text) {
        throw new LLMError(
          "The response was cut off at the token limit — it is " +
            "incomplete, so it has been discarded rather than shown " +
            "half-finished. Raise 'Max tokens per response' in step 1, " +
            "or lower the reasoning effort.",
        );
      }
      throw new LLMError(
        "The model hit its token limit before producing any visible " +
          "output — it spent the whole budget on reasoning. Raise " +
          "'Max tokens per response' in step 1, or lower the reasoning " +
          "effort.",
      );
    }

    if (!text) throw new LLMError("The model returned an empty response.");

    return text;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function describeError(exc: unknown): string {
  if (exc instanceof Error) {
    const cause = (exc as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${exc.message} (${cause.message})`;
    return exc.message;
  }
  return String(exc);
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return cpSlice(text ?? "", 400);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return cpSlice(pyStr(data), 400);
  }
  const error = (data as JsonObject).error;
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    return cpSlice(pyStr(pyOr((error as JsonObject).message, error)), 400);
  }
  return cpSlice(pyStr(pyOr(error, data)), 400);
}

export function mentions(text: string | null | undefined, ...needles: string[]): boolean {
  const low = (text || "").toLowerCase();
  return needles.some((needle) => low.includes(needle.toLowerCase()));
}

const FENCE_RE = new RegExp(`^[${PY_WS_CLASS}]*\`\`\`(?:json)?[${PY_WS_CLASS}]*|[${PY_WS_CLASS}]*\`\`\`[${PY_WS_CLASS}]*$`, "giu");

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Parse a JSON object out of a model reply, tolerating fences and prose. */
export function parseJsonObject(raw: string): JsonObject {
  const text = pyStrip(raw).replace(FENCE_RE, "");

  const whole = tryParse(text);
  if (whole.ok && isPlainObject(whole.value)) return whole.value;

  // Fall back to the first balanced {...} block in the text.
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const block = tryParse(text.slice(start, index + 1));
          if (block.ok) {
            if (isPlainObject(block.value)) return block.value;
          } else {
            break;
          }
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }

  throw new LLMError(
    "The model did not return valid JSON. First 300 characters of what it " + `sent:\n${cpSlice(raw, 300)}`,
  );
}
