/**
 * Parity with the Python app.
 *
 * parity/golden.json was produced by parity/generate.py running the ORIGINAL
 * Python modules. Every test here feeds the TypeScript the same inputs and
 * requires the same outputs — including every prompt the app sends, compared
 * character for character.
 *
 * Where the port deliberately differs from the Python, the test says so and
 * checks the new behaviour instead, with a comment giving the reason.
 */

import { describe, expect, it } from "vitest";

import * as config from "@/lib/config";
import * as ev from "@/lib/evaluation";
import * as iv from "@/lib/interview";
import {
  defaultModelSettings,
  estimatedCost,
  LLMClient,
  mentions,
  modelLabel,
  parseJsonObject,
  settingsAsDict,
  settingsSupportSampling,
  Usage,
  type ModelSettings,
} from "@/lib/llm";
import * as prompts from "@/lib/prompts";
import {
  cpLen,
  cpSlice,
  isPyUpper,
  pyFloat,
  pyFormat,
  pyLstrip,
  pyRound,
  pyRoundInt,
  pySplit,
  pySplitlines,
  pyStr,
  pyStrip,
  pyStripChars,
  pyTruthy,
} from "@/lib/py";
import * as js from "@/lib/scraper";

import { asResponse, attempt, FakeResponse, golden, StubClient } from "./helpers";

const G = golden();

/** Deep equality — JSON numbers 7.0 and 7 both arrive as 7. */
const same = (a: unknown, b: unknown) => expect(a).toEqual(b);

function withSamplingModel<T>(fn: () => T): T {
  config.MODEL_CHOICES["test/sampling-model"] = { ...config.MODEL_CHOICES[config.DEFAULT_MODEL], supports_sampling: true };
  try {
    return fn();
  } finally {
    delete config.MODEL_CHOICES["test/sampling-model"];
  }
}

// ---------------------------------------------------------------------------
describe("config and prompts are identical", () => {
  it("every Python config constant has the same value", () => {
    const deliberatelyDifferent = new Set(["OPENROUTER_APP_URL"]); // :8501 → :3000
    const tsConfig = config as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(G.config)) {
      if (deliberatelyDifferent.has(name)) continue;
      expect(tsConfig, `config.${name} is missing`).toHaveProperty(name);
      expect(tsConfig[name], `config.${name}`).toEqual(value);
    }
    expect(config.OPENROUTER_APP_URL).toBe("http://localhost:3000");
  });

  it("every prompt string is character-for-character the same", () => {
    const tsPrompts = prompts as unknown as Record<string, unknown>;
    const names = Object.keys(G.prompts.constants);
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      expect(tsPrompts[name], `prompts.${name}`).toEqual(G.prompts.constants[name]);
    }
  });

  it("the prompt helpers render identically, anchors on and off", () => {
    for (const [qt, h] of Object.entries(G.prompts.helpers) as [config.QuestionType, any][]) {
      expect(prompts.rubricBlock(qt)).toBe(h.rubric_block);
      expect(prompts.criteriaJsonKeys(qt)).toBe(h.criteria_json_keys);
      expect(prompts.calibrationBlock(qt, true)).toBe(h.calibration_block_on);
      expect(prompts.calibrationBlock(qt, false)).toBe(h.calibration_block_off);
    }
  });
});

// ---------------------------------------------------------------------------
describe("Python built-ins reproduced in lib/py.ts", () => {
  it("str.split / strip / lstrip / splitlines on awkward whitespace", () => {
    for (const [s, out] of G.py.split) same(pySplit(s), out);
    for (const [s, out] of G.py.strip) same(pyStrip(s), out);
    for (const [s, out] of G.py.lstrip) same(pyLstrip(s), out);
    for (const [s, out] of G.py.splitlines) same(pySplitlines(s), out);
    for (const [s, chars, out] of G.py.strip_chars) same(pyStripChars(s, chars), out);
  });

  it("slicing and len() count code points, not UTF-16 units", () => {
    for (const [s, n, out] of G.py.slice) same(cpSlice(s, n), out);
    for (const [s, n] of G.py.len) same(cpLen(s), n);
  });

  it("float() accepts and rejects exactly what Python does", () => {
    for (const [input, out] of G.py.float) {
      const got = pyFloat(input);
      if (out && typeof out === "object" && "null" in out) expect(got, JSON.stringify(input)).toBeNull();
      else if (Number.isNaN(out)) expect(got).toBeNaN();
      else expect(got, JSON.stringify(input)).toBe(out);
    }
  });

  it("round() — banker's rounding, and exact-tie detection at 2 dp", () => {
    for (const [x, out] of G.py.round2) expect(pyRound(x, 2), `round(${x}, 2)`).toBe(out);
    for (const [x, out] of G.py.round0) expect(pyRoundInt(x), `round(${x})`).toBe(out);
  });

  it("str() and bool() of JSON-shaped values", () => {
    for (const [v, out] of G.py.str) {
      // Known, unavoidable gap: JSON.parse cannot tell the float 1e16 from the
      // integer 10000000000000000, so a whole-number float prints as an int.
      if (typeof v === "number" && Number.isInteger(v) && /[e.]/.test(out)) continue;
      expect(pyStr(v), JSON.stringify(v)).toBe(out);
    }
    for (const [v, out] of G.py.truthy) expect(pyTruthy(v), JSON.stringify(v)).toBe(out);
  });

  it("str.format fills fields and doubles braces, and fails where Python fails", async () => {
    for (const [template, values, result] of G.py.format) {
      const got = await attempt(() => pyFormat(template, values));
      if ("ok" in result) expect(got.ok).toBe(result.ok);
      else expect(got.error, `${template} should fail`).toBeDefined();
    }
  });

  it("str.isupper() agrees on every code point Python's Unicode version assigns", () => {
    const inRanges = (cp: number, rs: [number, number][]) => rs.some(([a, b]) => cp >= a && cp <= b);
    const mismatches: number[] = [];
    for (const [a, b] of G.py.assigned_ranges as [number, number][]) {
      for (let cp = a; cp <= b; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const py = inRanges(cp, G.py.isupper_ranges);
        if (isPyUpper(String.fromCodePoint(cp)) !== py) mismatches.push(cp);
      }
    }
    // Both use the Unicode "Uppercase" property; any difference would come
    // from the two runtimes shipping different Unicode versions.
    expect(mismatches.map((c) => c.toString(16))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("llm.ts behaves like llm_client.py", () => {
  it("builds identical request bodies for every settings × profile × mode", () => {
    withSamplingModel(() => {
      for (const c of G.llm_build_body) {
        const client = new LLMClient({ apiKey: "k", settings: c.settings ? defaultModelSettings(c.settings) : null });
        const profile = c.raw_profile ?? config.MODEL_PROFILES[c.profile as config.ProfileName];
        const body = client.buildBody(profile, [{ role: "user", content: "hi" }], c.json, c.override);
        expect(body, JSON.stringify({ s: c.settings, p: c.profile, j: c.json, o: c.override })).toEqual(c.body);
      }
    });
  });

  it("estimates cost, labels and serialises settings identically", () => {
    withSamplingModel(() => {
      for (const [model, n, cost] of G.llm_estimated_cost) {
        expect(estimatedCost(defaultModelSettings({ model }), n), `${model} × ${n}`).toBe(cost);
      }
    });
    withSamplingModel(() => {
      for (const [sv, dict, label, sampling] of G.llm_settings_as_dict) {
        const s = defaultModelSettings(sv);
        expect(settingsAsDict(s)).toEqual(dict);
        expect(modelLabel(s)).toBe(label);
        expect(settingsSupportSampling(s)).toBe(sampling);
      }
    });
  });

  it("counts tokens, including the peak single completion", () => {
    const usage = new Usage();
    for (const step of G.llm_usage) {
      usage.add(step.payload);
      expect(usage.toJSON()).toEqual(step.state);
    }
  });

  it("extracts text and rejects truncated or empty replies with the same messages", async () => {
    for (const [payload, result] of G.llm_extract_text) {
      const got = await attempt(() => LLMClient.extractText(payload));
      if ("ok" in result) expect(got.ok).toBe(result.ok);
      else {
        expect(got.error).toBe("LLMError");
        expect(got.message).toBe(result.message);
      }
    }
  });

  it("parses JSON out of fences and prose, and fails the same way", async () => {
    for (const [raw, result] of G.llm_parse_json) {
      const got = await attempt(() => parseJsonObject(raw));
      if ("ok" in result) expect(got.ok, raw).toEqual(result.ok);
      else expect(got.message, raw).toBe(result.message);
    }
  });

  it("retries, strips rejected fields and gives up exactly as the Python does", async () => {
    for (const c of G.llm_retries) {
      const script: unknown[] = retryScript(c);
      const requests: { url: string; init: RequestInit }[] = [];
      const sleeps: number[] = [];
      const client = new LLMClient({
        apiKey: "sk-test",
        settings: defaultModelSettings({ model: "openai/gpt-5-mini", reasoning_effort: "low", max_tokens: 5000 }),
        fetchImpl: async (url, init) => {
          requests.push({ url, init });
          const item = script.shift();
          if (item === "NETWORK") throw new Error("connection refused");
          return asResponse(item as FakeResponse);
        },
        sleep: async (ms) => {
          sleeps.push(ms / 1000);
        },
      });
      const got = await attempt(() => client.chat([{ role: "user", content: "q" }], "evaluation", { jsonMode: c.json }));

      const label = `${c.name} (json=${c.json})`;
      if ("ok" in c.result) expect(got.ok, label).toBe(c.result.ok);
      else expect(got.message, label).toBe(c.result.message);
      expect(requests.length, label).toBe(c.requests.length);
      requests.forEach((r, i) => {
        const py = c.requests[i];
        expect(r.url).toBe(py.url);
        expect(JSON.parse(r.init.body as string), `${label} body ${i}`).toEqual(py.body);
        const { "HTTP-Referer": _ts, ...tsHeaders } = r.init.headers as Record<string, string>;
        const { "HTTP-Referer": _py, ...pyHeaders } = py.headers;
        expect(tsHeaders).toEqual(pyHeaders);
      });
      expect(sleeps, label).toEqual(c.sleeps);
      const { total_tokens: _t, ...usage } = client.usage.toJSON();
      expect(usage, label).toEqual(c.usage);
    }
  });

  it("matches needles case-insensitively", () => {
    for (const [text, needles, out] of G.llm_mentions) expect(mentions(text, ...needles)).toBe(out);
  });
});

/** Rebuild generate.py's scripted responses from what it recorded. */
function retryScript(c: any): unknown[] {
  // The recorded requests tell us how many responses were consumed; the
  // scripts themselves are reproduced here verbatim from generate.py.
  const ok = (content = "Done.") =>
    new FakeResponse(
      200,
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      "application/json",
    );
  const err = (status: number, message: unknown) =>
    new FakeResponse(status, JSON.stringify(message), "application/json");
  const scripts: Record<string, () => unknown[]> = {
    ok_first_time: () => [ok()],
    "429_then_ok": () => [err(429, { error: { message: "slow down" } }), ok()],
    "500_500_500": () => [0, 1, 2].map(() => err(500, { error: { message: "boom" } })),
    network_then_ok: () => ["NETWORK", ok()],
    network_x3: () => ["NETWORK", "NETWORK", "NETWORK"],
    json_mode_rejected: () => [err(400, { error: { message: "response_format json not supported" } }), ok('{"a": 1}')],
    reasoning_rejected: () => [err(400, { error: { message: "Unknown parameter: reasoning" } }), ok()],
    temperature_rejected: () => [err(400, { error: { message: "temperature is not supported" } }), ok()],
    "400_other": () => [err(400, { error: { message: "bad messages" } })],
    "401": () => [err(401, { error: { message: "No auth" } })],
    "402": () => [err(402, { error: { message: "Out of credit" } })],
    "404": () => [new FakeResponse(404, "<html>not found</html>")],
    "200_not_json": () => [new FakeResponse(200, "<html>")],
    error_not_dict: () => [err(418, { error: "teapot" })],
    error_missing: () => [err(418, { detail: "x" })],
    error_message_empty: () => [err(418, { error: { message: "", code: 9 } })],
    strip_three_times: () => [
      err(400, { error: { message: "response_format json unsupported" } }),
      err(400, { error: { message: "reasoning unsupported" } }),
      err(400, { error: { message: "top_p unsupported" } }),
    ],
    long_error: () => [new FakeResponse(400, "x".repeat(1000))],
  };
  const make = scripts[c.name];
  if (!make) throw new Error(`no script for ${c.name} — keep this table in step with generate.py`);
  return make();
}

// ---------------------------------------------------------------------------
describe("scraper.ts behaves like job_scraper.py", () => {
  it("normalises, validates and classifies URLs identically", () => {
    for (const [raw, normalised, valid, blocked] of G.scraper_urls) {
      expect(js.normaliseUrl(raw)).toBe(normalised);
      expect(js.isValidUrl(raw), raw).toBe(valid);
      expect(js.blockedDomain(normalised), raw).toBe(blocked);
    }
  });

  it("reduces HTML to the same text", () => {
    for (const [name, c] of Object.entries(G.scraper_html) as [string, any][]) {
      // Deliberate difference: BeautifulSoup drops the semicolon of an entity
      // it doesn't recognise ("&unknown;" → "&unknown"). htmlparser2 keeps the
      // page's actual text. Everything else in that case must still match.
      const expected = name === "entities_nbsp" ? c.text.replace("&unknown", "&unknown;") : c.text;
      expect(js.htmlToText(c.html), name).toBe(expected);
    }
  });

  it("fetches, and fails with the same messages, for every scripted response", async () => {
    for (const c of G.scraper_fetch) {
      const calls: { url: string; init: RequestInit }[] = [];
      const fetchImpl = async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (c.script === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
        if (c.script === "network") throw new TypeError("fetch failed", { cause: new Error("no route") });
        const body: Record<string, [number, string]> = {
          ok: [200, G.scraper_html.main_container.html],
          "404": [404, "nope"],
          "999": [999, "linkedin style"],
          js_rendered: [200, "<body><div id='root'></div><p>Loading…</p></body>"],
        };
        const [status, text] = body[c.script];
        return asResponse(new FakeResponse(status, text));
      };
      const result = await js.fetchPostingText(c.url, { fetchImpl });
      expect(result, `${c.script} ${c.url}`).toEqual(c.result);
      expect(calls.length).toBe(c.calls.length);
      calls.forEach((call, i) => {
        expect(call.url).toBe(c.calls[i].url);
        expect(call.init.headers).toEqual(c.calls[i].headers);
        expect(call.init.redirect).toBe("follow");
      });
    }
  });

  it("extracts postings identically — prompts sent, fields normalised, bullets recovered", async () => {
    expect(G.scraper_extract.length).toBeGreaterThan(20);
    for (const c of G.scraper_extract) {
      const stub = new StubClient([c.reply]);
      const job = await js.extractJobDescription(stub, c.page_text, c.url, { translate: c.translate });
      const label = JSON.stringify({ reply: Object.keys(c.reply), p: c.page_text.slice(0, 10), u: c.url, t: c.translate });
      expect(job, label).toEqual(c.job);
      expect(stub.sent, label).toEqual(c.sent);
      expect(js.toPromptText(job)).toBe(c.prompt_text);
      expect(js.displayTitle(job)).toBe(c.display_title);
      expect(js.hasOriginal(job)).toBe(c.has_original);
    }
  });

  it("cuts an over-long page by code points before it reaches the prompt", async () => {
    const long = "😀" + "y".repeat(40_010);
    const stub = new StubClient([{}]);
    const job = await js.extractJobDescription(stub, long, "", { translate: true });
    expect(cpLen(long)).toBe(G.scraper_extract_long.page_text_len);
    expect(cpLen(job.raw_text)).toBe(G.scraper_extract_long.raw_text_len);
    expect(stub.sent[0].messages[1].content.slice(-60)).toBe(G.scraper_extract_long.sent_user_tail);
    expect(js.toPromptText(job)).toBe(G.scraper_extract_long.prompt_text);
  });

  it("builds the prep plan identically, caps and flattening included", async () => {
    const job = G.job_for_plan as js.JobDescription;
    for (const c of [...G.scraper_plan, G.scraper_plan_type_error]) {
      const stub = new StubClient([c.reply]);
      const got = await attempt(() => js.buildPrepPlan(stub, job));
      if ("ok" in c.plan) expect(got.ok, JSON.stringify(c.reply)).toEqual(c.plan.ok);
      else {
        expect(got.error).toBe("TypeError");
        expect(got.message).toBe(c.plan.message);
      }
      expect(stub.sent).toEqual(c.sent);
    }
  });

  it("renders the posting for prompts identically", () => {
    for (const c of G.scraper_job_helpers) {
      expect(js.toPromptText(c.job)).toBe(c.prompt_text);
      expect(js.displayTitle(c.job)).toBe(c.display_title);
      expect(js.hasOriginal(c.job)).toBe(c.has_original);
    }
  });
});

// ---------------------------------------------------------------------------
describe("interview.ts behaves like interview.py", () => {
  it("splits, plans and describes interviews identically", async () => {
    for (const [total, result] of G.interview_split) {
      const got = await attempt(() => iv.splitQuestions(total));
      if ("ok" in result) expect(got.ok, String(total)).toEqual(result.ok);
      else expect(got.message, String(total)).toBe(result.message);
    }
    for (const [n, plan] of G.interview_plan) {
      expect(iv.buildQuestionPlan(iv.defaultInterviewSettings({ num_questions: n }))).toEqual(plan);
    }
    for (const [n, dict] of G.interview_settings) {
      expect(iv.interviewSettingsAsDict(iv.defaultInterviewSettings({ num_questions: n }))).toEqual(dict);
    }
  });

  it("assembles all 36 interviewer system prompts identically", () => {
    const job = G.tech_job as js.JobDescription;
    expect(G.interview_system_prompts.length).toBe(36);
    for (const c of G.interview_system_prompts) {
      const settings = iv.defaultInterviewSettings({
        language: c.language,
        difficulty: c.difficulty,
        attitude: c.attitude,
        num_questions: c.num_questions,
      });
      expect(iv.buildSystemPrompt(job, settings)).toBe(c.prompt);
    }
  });

  it("tidies labels off questions identically", () => {
    for (const [text, out] of G.interview_tidy) expect(iv.tidyQuestion(text)).toBe(out);
  });

  it("runs whole interviews one question at a time, sending identical messages", async () => {
    const job = G.tech_job as js.JobDescription;
    for (const run of G.interview_runs) {
      const settings = iv.defaultInterviewSettings({
        language: "German",
        difficulty: "Hard",
        attitude: "Strict",
        num_questions: run.num_questions,
      });
      const total = iv.totalQuestions(settings);
      const stub = new StubClient(Array.from({ length: total + 1 }, (_, i) => `Question: number ${i + 1} for you?`));
      let transcript: iv.TurnRecord[] = [];
      const trace: unknown[] = [];
      for (let i = 0; i < total; i++) {
        transcript = [...transcript, await iv.nextQuestion(stub, job, settings, transcript)];
        trace.push({ awaiting: iv.awaitingAnswer(transcript), progress: iv.progress(transcript, settings) });
        transcript = iv.recordAnswer(transcript, run.answers[i % run.answers.length]);
        trace.push({ complete: iv.isComplete(transcript, settings), progress: iv.progress(transcript, settings) });
      }
      const extra = await attempt(() => iv.nextQuestion(stub, job, settings, transcript));
      expect(stub.sent).toEqual(run.sent);
      expect(transcript).toEqual(run.transcript);
      expect(trace).toEqual(run.trace);
      expect(extra.message).toBe(run.extra_question.message);
    }
  });

  it("refuses to record an answer twice, or with no question", async () => {
    const e = G.interview_record_errors;
    expect((await attempt(() => iv.recordAnswer([], "x"))).message).toBe(e.empty.message);
    const answeredOnce = iv.recordAnswer(
      [{ number: 1, question_type: "intro", question: "Q?", answer: null, evaluation: null }],
      "a",
    );
    expect((await attempt(() => iv.recordAnswer(answeredOnce, "b"))).message).toBe(e.twice.message);
    expect(iv.answered({ number: 1, question_type: "intro", question: "Q", answer: "   ", evaluation: null })).toBe(
      e.blank_answer_not_answered,
    );
  });
});

// ---------------------------------------------------------------------------
describe("evaluation.ts behaves like evaluation.py", () => {
  it("clamps scores, collapses lines and normalises lists identically", () => {
    for (const [v, out] of G.eval_clamp) expect(ev.clampScore(v), JSON.stringify(v)).toBe(out);
    for (const [v, out] of G.eval_one_line) expect(ev.oneLine(v)).toBe(out);
    for (const [v, out] of G.eval_as_list) expect(ev.asStringList(v)).toEqual(out);
  });

  it(`splits sentences identically on ${golden().eval_sentences.length} cases, most of them generated`, () => {
    for (const [text, split, three, one] of G.eval_sentences) {
      if (typeof text === "string") expect(ev.splitSentences(text), text).toEqual(split);
      expect(ev.limitSentences(text, 3), String(text)).toBe(three);
      expect(ev.limitSentences(text, 1), String(text)).toBe(one);
    }
  });

  it("scores single answers identically — prompts sent, and results", async () => {
    const job = G.tech_job as js.JobDescription;
    for (const c of G.eval_turns) {
      const stub = new StubClient([c.reply]);
      const turn: iv.TurnRecord = {
        number: 2,
        question_type: c.qtype,
        question: "How would you do it?",
        answer: c.answer,
        evaluation: null,
      };
      const got = await attempt(() =>
        ev.evaluateTurn(stub, job, turn, iv.defaultInterviewSettings({ language: c.language })),
      );
      const label = JSON.stringify({ q: c.qtype, a: c.answer, r: c.reply, l: c.language });
      if ("ok" in c.result) expect(got.ok, label).toEqual(c.result.ok);
      else {
        expect(got.error, label).toBe("LLMError");
        expect(got.message).toBe(c.result.message);
      }
      expect(stub.sent, label).toEqual(c.sent);
    }
  });

  it("produces identical placeholder evaluations when a call fails", () => {
    const types = Object.keys(config.RUBRICS) as config.QuestionType[];
    types.forEach((qt, i) => {
      expect(
        ev.failedEvaluation({ number: 1, question_type: qt, question: "Q", answer: null, evaluation: null }, "boom"),
      ).toEqual(G.eval_failed[i]);
    });
  });

  it("aggregates for the charts, and writes the summary digest, identically", () => {
    for (const c of G.eval_aggregates) {
      const tr = c.transcript as iv.TurnRecord[];
      expect(ev.overallScore(tr)).toBe(c.overall_score);
      expect(ev.categoryAverages(tr)).toEqual(c.category_averages);
      expect(ev.categoryOverall(tr)).toEqual(c.category_overall);
      expect(ev.perQuestionRows(tr)).toEqual(c.per_question_rows);
      expect(ev.buildResultsDigest(tr)).toBe(c.digest);
      expect(ev.scoredTurns(tr).map((t) => t.number)).toEqual(c.scored_numbers);
    }
    const empty = G.eval_aggregates_empty;
    expect(ev.overallScore([])).toBe(empty.overall_score);
    expect(ev.categoryAverages([])).toEqual(empty.category_averages);
    expect(ev.buildResultsDigest([])).toBe(empty.digest);
  });

  it("builds the closing summary identically, including when the call fails", async () => {
    const job = G.tech_job as js.JobDescription;
    for (const c of G.eval_summaries) {
      const stub = new StubClient([c.reply]);
      const result = await ev.buildOverallSummary(stub, job, c.transcript, iv.defaultInterviewSettings({ language: "German" }));
      expect(result, JSON.stringify(c.reply)).toEqual(c.result);
      expect(stub.sent).toEqual(c.sent);
    }
  });

  it("evaluates a whole transcript, skipping done turns and absorbing failures", async () => {
    const e = G.eval_evaluate_all;
    const replies = [G.eval_turns[0].reply, { __raise__: "cut off" }, { scores: { Context: 6.5, "Technical Knowledge": 7.5, Structure: 2.5, Language: 3.5 } }];
    const stub = new StubClient(replies);
    const input: iv.TurnRecord[] = [1, 2, 3].map((n) => ({
      number: n,
      question_type: "technical",
      question: `Q${n}`,
      answer: "abc"[n - 1],
      evaluation: null,
    }));
    input.push({ number: 4, question_type: "intro", question: "Q4", answer: "d", evaluation: { already: true } as never });
    const progress: number[][] = [];
    const out = await ev.evaluateAll(stub, G.tech_job, input, iv.defaultInterviewSettings(), (d, t) => progress.push([d, t]));
    expect(out).toEqual(e.transcript);
    expect(progress).toEqual(e.progress);
    expect(stub.sent.length).toBe(e.calls);
  });

  it("bands scores and exports the report identically", () => {
    for (const [s, band, color] of G.eval_bands) {
      expect(ev.scoreBand(s)).toBe(band);
      expect(ev.scoreColor(s)).toBe(color);
    }
    const x = G.eval_export;
    const model: ModelSettings = defaultModelSettings({ model: "openai/gpt-5", seed: 3 });
    expect(
      ev.transcriptToExport(x.transcript, G.tech_job, iv.defaultInterviewSettings({ num_questions: 6 }), { headline: "h" }, model),
    ).toEqual(x.export);
    expect(ev.transcriptToExport(x.transcript, G.tech_job, iv.defaultInterviewSettings(), null, null)).toEqual(
      x.export_no_model,
    );
  });
});

