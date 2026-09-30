/**
 * POST /api/job, tested through handleJobRequest (the Route Handler is a thin
 * wrapper) plus the route itself for the one thing only it does: reject a
 * body that isn't JSON. No network and no key: the model and the page fetch
 * are both scripted.
 */

import { describe, expect, it } from "vitest";

import * as config from "@/lib/config";
import { handleJobRequest, MIN_PASTED_CHARS } from "@/lib/api/job";
import { InputError, parseModelSettings } from "@/lib/api/settings";
import { LLMClient, LLMError, type ModelSettings } from "@/lib/llm";
import { StubClient, FakeResponse, asResponse } from "./helpers";

const POSTING = { is_job_posting: true, job_title: "Data Engineer", company: "Acme", requirements: ["SQL"], summary: "Pipelines." };
const PLAN = { key_skills: ["SQL"], interview_topics: ["Modelling"], study_plan: [{ strategy: "Practise", description: "Daily." }] };
const PAGE = `<html><body><main>${"<p>We are hiring a data engineer to build pipelines.</p>".repeat(20)}</main></body></html>`;
const LONG_TEXT = "Data Engineer at Acme. ".repeat(10);

function deps(replies: unknown[], page: FakeResponse | Error = new FakeResponse(200, PAGE)) {
  const clients: { client: StubClient; settings: ModelSettings }[] = [];
  const fetched: string[] = [];
  return {
    clients,
    fetched,
    deps: {
      makeClient: (settings: ModelSettings) => {
        const client = new StubClient(replies);
        clients.push({ client, settings });
        return client;
      },
      fetchImpl: async (url: string) => {
        fetched.push(url);
        if (page instanceof Error) throw page;
        return asResponse(page);
      },
    },
  };
}

describe("handleJobRequest", () => {
  it("reads a posting from a link and returns the job, plan and usage", async () => {
    const d = deps([POSTING, PLAN]);
    const { status, body } = await handleJobRequest({ url: "careers.example.com/jobs/1" }, d.deps);
    expect(status).toBe(200);
    if (!body.ok) throw new Error(JSON.stringify(body));
    expect(body.source).toBe("url");
    expect(body.job.job_title).toBe("Data Engineer");
    expect(body.job.source_url).toBe("https://careers.example.com/jobs/1");
    expect(body.plan.key_skills).toEqual(["SQL"]);
    expect(body.usage).toHaveProperty("total_tokens");
    expect(d.fetched).toEqual(["https://careers.example.com/jobs/1"]);
    expect(d.clients[0].client.sent.map((s) => s.profile)).toEqual(["job_extraction", "prep_plan"]);
    // The page text, not the HTML, is what the model sees.
    expect(d.clients[0].client.sent[0].messages[1].content).toContain("We are hiring a data engineer");
    expect(d.clients[0].client.sent[0].messages[1].content).not.toContain("<p>");
  });

  it("uses pasted text when given, and never fetches", async () => {
    const d = deps([POSTING, PLAN]);
    const { status, body } = await handleJobRequest({ url: "https://x.example/1", text: LONG_TEXT }, d.deps);
    expect(status).toBe(200);
    expect(body.ok && body.source).toBe("text");
    expect(body.ok && body.job.source_url).toBe("https://x.example/1");
    expect(d.fetched).toEqual([]);
  });

  it("passes validated model settings to the client", async () => {
    const d = deps([POSTING, PLAN]);
    await handleJobRequest({ text: LONG_TEXT, settings: { model: "openai/gpt-5-nano", reasoning_effort: "low" } }, d.deps);
    expect(d.clients[0].settings.model).toBe("openai/gpt-5-nano");
    expect(d.clients[0].settings.reasoning_effort).toBe("low");
  });

  it("rejects a paste that is too short", async () => {
    const d = deps([]);
    const { status, body } = await handleJobRequest({ text: "x".repeat(MIN_PASTED_CHARS - 1) }, d.deps);
    expect(status).toBe(422);
    expect(body).toMatchObject({ ok: false, stage: "input" });
    expect(!body.ok && body.error).toContain("very short");
    expect(d.clients).toHaveLength(0);
  });

  it("rejects a request with neither link nor text, or a non-object", async () => {
    for (const input of [{}, { url: "  ", text: "\n" }, null, [], "https://x.example"]) {
      const { status, body } = await handleJobRequest(input, deps([]).deps);
      expect(status, JSON.stringify(input)).toBe(400);
      expect(body).toMatchObject({ ok: false, stage: "input" });
    }
  });

  it("reports a failed fetch with the scraper's hint", async () => {
    const { status, body } = await handleJobRequest({ url: "https://x.example/1" }, deps([], new FakeResponse(404, "gone")).deps);
    expect(status).toBe(422);
    expect(body).toMatchObject({ ok: false, stage: "fetch" });
    expect(!body.ok && body.hint).toBeTruthy();
  });

  it("reports a known-blocked site without fetching it", async () => {
    const d = deps([]);
    const { status, body } = await handleJobRequest({ url: "https://www.linkedin.com/jobs/view/1" }, d.deps);
    expect(status).toBe(422);
    expect(!body.ok && body.error).toContain("blocks automated page fetches");
    expect(d.fetched).toEqual([]);
  });

  it("uses the model's own note when the page isn't a posting", async () => {
    const d = deps([{ is_job_posting: false, extraction_note: "This is a company blog." }]);
    const { status, body } = await handleJobRequest({ text: LONG_TEXT }, d.deps);
    expect(status).toBe(422);
    expect(body).toMatchObject({
      ok: false,
      stage: "not_a_posting",
      error: "That page doesn't look like a job posting. This is a company blog.",
    });
    expect(d.clients[0].client.sent).toHaveLength(1); // no plan call
  });

  it("falls back to a generic hint when the model gives no note", async () => {
    const { body } = await handleJobRequest({ text: LONG_TEXT }, deps([{ is_job_posting: false }]).deps);
    expect(!body.ok && body.error).toBe(
      "That page doesn't look like a job posting. Try a direct link to the posting itself.",
    );
  });

  it("turns a model failure into a 502, at either call", async () => {
    for (const replies of [[{ __raise__: "Rate limited." }], [POSTING, { __raise__: "Rate limited." }]]) {
      const { status, body } = await handleJobRequest({ text: LONG_TEXT }, deps(replies).deps);
      expect(status).toBe(502);
      expect(body).toEqual({ ok: false, stage: "model", error: "Rate limited." });
    }
  });

  it("turns a missing key into a 500 that names the fix — and never a key", async () => {
    const { status, body } = await handleJobRequest(
      { text: LONG_TEXT },
      { makeClient: (settings) => new LLMClient({ apiKey: "", settings }) },
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, stage: "config" });
    expect(!body.ok && body.error).toContain(config.API_KEY_ENV_VAR);
    expect(!body.ok && body.error).toContain(".env.local");
  });

  it("rejects out-of-range settings before doing anything", async () => {
    const d = deps([]);
    const { status, body } = await handleJobRequest({ text: LONG_TEXT, settings: { max_tokens: 1_000_000 } }, d.deps);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, stage: "input" });
    expect(d.clients).toHaveLength(0);
  });

  it("lets an unexpected bug surface instead of hiding it as a model error", async () => {
    await expect(
      handleJobRequest({ text: LONG_TEXT }, { makeClient: () => { throw new TypeError("bug"); } }),
    ).rejects.toThrow(TypeError);
  });
});

describe("parseModelSettings", () => {
  it("defaults when nothing is sent", () => {
    for (const input of [undefined, null]) {
      expect(parseModelSettings(input)).toEqual(parseModelSettings({}));
    }
    expect(parseModelSettings({}).model).toBe(config.DEFAULT_MODEL);
  });

  it("accepts every value the UI can offer", () => {
    for (const model of Object.keys(config.MODEL_CHOICES)) {
      for (const effort of config.REASONING_EFFORT_OPTIONS) {
        const s = parseModelSettings({
          model,
          reasoning_effort: effort,
          max_tokens: config.MAX_TOKENS_MAX,
          temperature: config.TEMPERATURE_MIN,
          seed: 0,
        });
        expect(s).toMatchObject({ model, reasoning_effort: effort, max_tokens: config.MAX_TOKENS_MAX, seed: 0 });
      }
    }
    expect(parseModelSettings({ max_tokens: config.MAX_TOKENS_MIN, seed: null }).seed).toBeNull();
  });

  it.each([
    ["not an object", "fast"],
    ["an array", []],
    ["an unlisted model", { model: "anthropic/something-expensive" }],
    ["a model that isn't a string", { model: 5 }],
    ["an unknown effort", { reasoning_effort: "extreme" }],
    ["too few tokens", { max_tokens: config.MAX_TOKENS_MIN - 1 }],
    ["too many tokens", { max_tokens: config.MAX_TOKENS_MAX + 1 }],
    ["fractional tokens", { max_tokens: 5000.5 }],
    ["tokens as a string", { max_tokens: "8000" }],
    ["temperature out of range", { temperature: 2.5 }],
    ["a NaN temperature", { temperature: NaN }],
    ["a fractional seed", { seed: 1.5 }],
    ["an unsafe seed", { seed: 2 ** 60 }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseModelSettings(input)).toThrow(InputError);
  });

  it("an LLMError is not an InputError (they map to different statuses)", () => {
    expect(new LLMError("x")).not.toBeInstanceOf(InputError);
  });
});

describe("POST /api/job route", () => {
  it("rejects a body that isn't JSON with a 400", async () => {
    const { POST } = await import("@/app/api/job/route");
    const response = await POST(new Request("http://localhost/api/job", { method: "POST", body: "not json" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, stage: "input" });
  });

  it("answers a missing key with a 500, not a crash", async () => {
    const saved = process.env[config.API_KEY_ENV_VAR];
    delete process.env[config.API_KEY_ENV_VAR];
    try {
      const { POST } = await import("@/app/api/job/route");
      const response = await POST(
        new Request("http://localhost/api/job", { method: "POST", body: JSON.stringify({ text: LONG_TEXT }) }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, stage: "config" });
    } finally {
      if (saved !== undefined) process.env[config.API_KEY_ENV_VAR] = saved;
    }
  });
});
