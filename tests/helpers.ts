/** Shared test doubles: a scripted chat client and a scripted HTTP response. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ProfileName } from "@/lib/config";
import { LLMError, Usage, type ChatClient, type ChatMessage, type JsonObject } from "@/lib/llm";

export interface Sent {
  profile: ProfileName;
  json: boolean;
  messages: ChatMessage[];
}

/**
 * Stands in for LLMClient, exactly like parity/generate.py's StubClient:
 * records what was sent, replays scripted replies. A reply of
 * {"__raise__": "msg"} throws LLMError("msg").
 */
export class StubClient implements ChatClient {
  readonly sent: Sent[] = [];
  readonly usage = new Usage();
  private readonly replies: unknown[];

  constructor(replies: unknown[]) {
    this.replies = [...replies];
  }

  private next(): unknown {
    const reply = this.replies.shift();
    if (reply && typeof reply === "object" && "__raise__" in reply) {
      throw new LLMError(String((reply as { __raise__: unknown }).__raise__));
    }
    return reply;
  }

  async chat(messages: ChatMessage[], profile: ProfileName): Promise<string> {
    this.sent.push({ profile, json: false, messages: structuredClone(messages) });
    return this.next() as string;
  }

  async chatJson(messages: ChatMessage[], profile: ProfileName): Promise<JsonObject> {
    this.sent.push({ profile, json: true, messages: structuredClone(messages) });
    return structuredClone(this.next()) as JsonObject;
  }
}

/**
 * A minimal stand-in for fetch's Response. Hand-rolled because the real
 * Response constructor refuses statuses outside 200–599, and LinkedIn really
 * does answer with 999.
 */
export class FakeResponse {
  readonly headers: Headers;
  constructor(
    readonly status: number,
    private readonly bodyText: string,
    contentType = "text/html; charset=utf-8",
  ) {
    this.headers = new Headers({ "content-type": contentType });
  }
  async text() {
    return this.bodyText;
  }
  async json() {
    return JSON.parse(this.bodyText);
  }
  async arrayBuffer() {
    const bytes = new TextEncoder().encode(this.bodyText);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

export function asResponse(r: FakeResponse): Response {
  return r as unknown as Response;
}

let cachedGolden: Record<string, any> | null = null;

/** parity/golden.json — the Python app's recorded behaviour. */
export function golden(): Record<string, any> {
  if (!cachedGolden) {
    const path = fileURLToPath(new URL("../parity/golden.json", import.meta.url));
    cachedGolden = decode(JSON.parse(readFileSync(path, "utf-8"))) as Record<string, any>;
  }
  return cachedGolden;
}

/** Undo generate.py's enc(): NaN and infinities travel as {"__float__": …}. */
export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === "__float__") {
      return { nan: NaN, inf: Infinity, "-inf": -Infinity }[obj.__float__ as string];
    }
    return Object.fromEntries(keys.map((k) => [k, decode(obj[k])]));
  }
  return value;
}

/** Run `fn`, returning {ok} or {message} the way generate.py's attempt() does. */
export async function attempt<T>(fn: () => T | Promise<T>): Promise<{ ok?: T; error?: string; message?: string }> {
  try {
    return { ok: await fn() };
  } catch (exc) {
    return { error: (exc as Error).name, message: (exc as Error).message };
  }
}
