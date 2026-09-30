/**
 * The ONLY place the API key is read.
 *
 * `import "server-only"` turns any attempt to import this file from a Client
 * Component into a build error, so the key cannot be bundled into JavaScript
 * that ships to the browser — not by accident, not by a future refactor. It is
 * also not a NEXT_PUBLIC_ variable, so Next.js would not inline it into client
 * code even without this guard. Belt and braces.
 */
import "server-only";

import { API_KEY_ENV_VAR } from "../config";
import { LLMClient, type ModelSettings } from "../llm";

export function createServerClient(settings: ModelSettings | null = null): LLMClient {
  return new LLMClient({ apiKey: process.env[API_KEY_ENV_VAR] ?? "", settings });
}

/** Whether a key is configured — never the key itself. */
export function hasApiKey(): boolean {
  return Boolean((process.env[API_KEY_ENV_VAR] ?? "").trim());
}
