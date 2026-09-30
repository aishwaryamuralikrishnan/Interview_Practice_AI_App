/**
 * Validate model settings arriving from the browser.
 *
 * The Streamlit app never needed this: the widgets and the code that used
 * their values ran in one process, so an out-of-range value could not exist.
 * Here the browser is untrusted. Anything it sends is checked against the same
 * bounds config.ts gives the UI, so a hand-crafted request cannot pick an
 * unlisted (possibly expensive) model or a 1,000,000-token cap.
 */

import * as config from "../config";
import { defaultModelSettings, type ModelSettings } from "../llm";

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseModelSettings(input: unknown): ModelSettings {
  if (input === undefined || input === null) return defaultModelSettings();
  if (!isRecord(input)) throw new InputError("settings must be an object");
  const s = defaultModelSettings();

  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !(input.model in config.MODEL_CHOICES)) {
      throw new InputError(`model must be one of: ${Object.keys(config.MODEL_CHOICES).join(", ")}`);
    }
    s.model = input.model;
  }

  if (input.reasoning_effort !== undefined) {
    if (!(config.REASONING_EFFORT_OPTIONS as readonly unknown[]).includes(input.reasoning_effort)) {
      throw new InputError(`reasoning_effort must be one of: ${config.REASONING_EFFORT_OPTIONS.join(", ")}`);
    }
    s.reasoning_effort = input.reasoning_effort as ModelSettings["reasoning_effort"];
  }

  if (input.max_tokens !== undefined) {
    const n = input.max_tokens;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < config.MAX_TOKENS_MIN ||
      n > config.MAX_TOKENS_MAX
    ) {
      throw new InputError(`max_tokens must be an integer from ${config.MAX_TOKENS_MIN} to ${config.MAX_TOKENS_MAX}`);
    }
    s.max_tokens = n;
  }

  if (input.temperature !== undefined) {
    const t = input.temperature;
    if (typeof t !== "number" || !Number.isFinite(t) || t < config.TEMPERATURE_MIN || t > config.TEMPERATURE_MAX) {
      throw new InputError(`temperature must be from ${config.TEMPERATURE_MIN} to ${config.TEMPERATURE_MAX}`);
    }
    s.temperature = t;
  }

  if (input.seed !== undefined && input.seed !== null) {
    if (typeof input.seed !== "number" || !Number.isSafeInteger(input.seed)) {
      throw new InputError("seed must be an integer or null");
    }
    s.seed = input.seed;
  }

  return s;
}
