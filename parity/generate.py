"""
Record the Python app's behaviour, so the TypeScript port can be held to it.

Runs the ORIGINAL modules — config, prompts, llm_client, job_scraper,
interview, evaluation — on a large fixed set of inputs, with the model and the
network stubbed out, and writes every input and output to parity/golden.json.
That includes every message the app would have sent to the model, so prompt
assembly is compared character for character, not just the helper functions.

tests/parity.test.ts then feeds the same inputs to the TypeScript and fails on
any difference.

    python parity/generate.py ../interview_preparation_app

Regenerate whenever the Python version changes, if you keep changing it.
"""

from __future__ import annotations

import json
import math
import random
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY_APP = Path(sys.argv[1] if len(sys.argv) > 1 else HERE.parent.parent / "interview_preparation_app").resolve()
sys.path.insert(0, str(PY_APP))

import requests  # noqa: E402

import config  # noqa: E402
import evaluation as ev  # noqa: E402
import interview as iv  # noqa: E402
import job_scraper as js  # noqa: E402
import llm_client as lc  # noqa: E402
import prompts  # noqa: E402

rng = random.Random(20260929)
G: dict = {"python": sys.version.split()[0], "unicode": unicodedata.unidata_version}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def enc(value):
    """JSON-safe encoding that keeps NaN/inf and tuples distinguishable."""
    if isinstance(value, float):
        if math.isnan(value):
            return {"__float__": "nan"}
        if math.isinf(value):
            return {"__float__": "inf" if value > 0 else "-inf"}
        return value
    if isinstance(value, dict):
        return {str(k): enc(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [enc(v) for v in value]
    return value


def attempt(fn, *args, **kwargs):
    try:
        return {"ok": enc(fn(*args, **kwargs))}
    except Exception as exc:  # record the failure, not just that it failed
        return {"error": type(exc).__name__, "message": str(exc)}


def ranges(codepoints):
    out, start, prev = [], None, None
    for cp in codepoints:
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            out.append([start, prev])
            start = prev = cp
    if start is not None:
        out.append([start, prev])
    return out


class StubClient:
    """Stands in for LLMClient: records what was sent, replays scripted replies."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.sent = []

    def _next(self):
        reply = self.replies.pop(0)
        if isinstance(reply, dict) and "__raise__" in reply:
            raise lc.LLMError(reply["__raise__"])
        return reply

    def chat(self, messages, profile, json_mode=False, max_tokens_override=None):
        self.sent.append({"profile": profile, "json": False, "messages": messages})
        return self._next()

    def chat_json(self, messages, profile, max_tokens_override=None):
        self.sent.append({"profile": profile, "json": True, "messages": messages})
        return self._next()


# ---------------------------------------------------------------------------
# config and prompts
# ---------------------------------------------------------------------------

def public_constants(module, exclude_from=None):
    out = {}
    for name in dir(module):
        if name.isupper():
            value = getattr(module, name)
            if exclude_from is not None and getattr(exclude_from, name, object()) is value:
                continue  # re-exported from another module, e.g. prompts importing RUBRICS
            if isinstance(value, (str, int, float, bool, dict, list, tuple)):
                out[name] = enc(value)
    return out


G["config"] = public_constants(config)
G["prompts"] = {
    "constants": public_constants(prompts, exclude_from=config),
    "helpers": {
        qt: {
            "rubric_block": prompts.rubric_block(qt),
            "criteria_json_keys": prompts.criteria_json_keys(qt),
            "calibration_block_on": prompts.calibration_block(qt),
        }
        for qt in config.RUBRICS
    },
}
_saved = config.USE_EVALUATION_ANCHORS
config.USE_EVALUATION_ANCHORS = False
import importlib  # noqa: E402

importlib.reload(prompts)
for qt in config.RUBRICS:
    G["prompts"]["helpers"][qt]["calibration_block_off"] = prompts.calibration_block(qt)
config.USE_EVALUATION_ANCHORS = _saved
importlib.reload(prompts)


# ---------------------------------------------------------------------------
# Python built-in behaviour the port reproduces (lib/py.ts)
# ---------------------------------------------------------------------------

WS = " \t\n\x0b\x0c\r\x1c\x1d\x1e\x1f\x85\xa0        　﻿​"
WORDS = ["alpha", "Beta", "ä", "Straße", "😀", "z.B.", "x", "", "7", "٣", "_", "-"]


def rand_ws_string():
    parts = []
    for _ in range(rng.randint(0, 8)):
        parts.append(rng.choice(WORDS) if rng.random() < 0.6 else "".join(rng.choice(WS) for _ in range(rng.randint(1, 3))))
    return "".join(parts)


strings = [rand_ws_string() for _ in range(300)] + ["", " ", "﻿x﻿", "a\u0085b", "a\r\nb\rc\nd", "\n", "a\n", "x\x1fy"]
G["py"] = {
    "split": [[s, s.split()] for s in strings],
    "strip": [[s, s.strip()] for s in strings],
    "lstrip": [[s, s.lstrip()] for s in strings],
    "splitlines": [[s, s.splitlines()] for s in strings],
    "strip_chars": [[s, c, s.strip(c)] for s in ["..a,;b; ", " .x", "", ",,,", "a"] for c in [" .;,", "."]],
    "slice": [[s, n, s[:n]] for s in ["😀😀abc", "abc", "", "ß😀"] for n in [0, 1, 2, 3, 10]],
    "len": [[s, len(s)] for s in ["😀😀abc", "", "ä"]],
}

float_inputs = [
    "7", " 7 ", "7.5", "-7.5", "+3", "1e2", "1E-2", "1.", ".5", ".", "1_000", "1__0", "_1", "1_",
    "1e", "1e1_0", "inf", "-Infinity", "nan", "NaN", "0x10", "7/10", "", " ", "８", "٧.٥", " 7 ",
    "﻿7", "7 8", "1.2.3", "１_０", True, False, None, 3, 2.5, [], [7], {}, "true",
]


def py_float(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return {"null": True}
    return enc(f)


G["py"]["float"] = [[enc(v), py_float(v)] for v in float_inputs]

round_inputs = [
    0.0, 0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5, 0.49999999999999994, 2.675, 6.125, 6.375, 6.625, 6.875,
    0.125, 1.005, 7.0, 6.75, 6.25, 9.999, -6.125, 5.555, 0.015, 0.025, 1e-9, 123456.785,
] + [rng.randint(0, 4000) / rng.choice([4, 8, 16, 3, 7, 40, 400]) for _ in range(300)]
G["py"]["round2"] = [[x, round(x, 2)] for x in round_inputs]
G["py"]["round0"] = [[x, round(x)] for x in round_inputs if abs(x) < 1e15]

str_inputs = ["x", "", 0, 1, -3, 7.5, 0.1, 1e-5, 1e16, 12345678901234567.0, 2.5e-7, True, False, None,
              [1, "a", None], {"a": 1, "b": [True]}, ["it's"], {"k": 'say "hi"'}]
G["py"]["str"] = [[enc(v), str(v)] for v in str_inputs]
G["py"]["truthy"] = [[enc(v), bool(v)] for v in str_inputs + [[], {}, 0.0, " "]]

G["py"]["format"] = [
    ["Hello {name}!", {"name": "Ana"}],
    ["{{literal}} and {x}", {"x": 3}],
    ["{{{keys}}}", {"keys": '"a": 1'}],
    ["{a}{b}{a}", {"a": "1", "b": None}],
    ["{missing}", {}],
    ["single } brace", {}],
    ["{ spaced }", {" spaced ": 1}],
    ["no fields", {"unused": 1}],
]
G["py"]["format"] = [[t, v, attempt(t.format, **v)] for t, v in G["py"]["format"]]

upper = [c for c in range(0x110000) if chr(c).isupper()]
assigned = [c for c in range(0x110000) if unicodedata.category(chr(c)) != "Cn"]
G["py"]["isupper_ranges"] = ranges(upper)
G["py"]["assigned_ranges"] = ranges(assigned)


# ---------------------------------------------------------------------------
# llm_client
# ---------------------------------------------------------------------------

messages = [{"role": "user", "content": "hi"}]
body_cases = []
config.MODEL_CHOICES["test/sampling-model"] = dict(config.MODEL_CHOICES[config.DEFAULT_MODEL], supports_sampling=True)
settings_variants = [
    None,
    dict(model="openai/gpt-5-nano", reasoning_effort="high", max_tokens=12000, temperature=1.9, seed=7),
    dict(model="openai/gpt-5", reasoning_effort="minimal", max_tokens=3000, temperature=0.7, seed=None),
    dict(model="test/sampling-model", reasoning_effort="low", max_tokens=5000, temperature=0.3, seed=0),
    dict(model="unknown/model", reasoning_effort="", max_tokens=4000, temperature=0.3, seed=None),
]
for sv in settings_variants:
    for profile in config.MODEL_PROFILES:
        for json_mode in (False, True):
            for override in (None, 0, 1234):
                client = lc.LLMClient(api_key="k")
                client.settings = lc.ModelSettings(**sv) if sv else None
                body = client._build_body(config.MODEL_PROFILES[profile], messages, json_mode, override)
                body_cases.append({"settings": sv, "profile": profile, "json": json_mode, "override": override, "body": body})
# A profile for a sampling model, without user settings, forwards every sampling key.
profile_with_sampling = {"model": "test/sampling-model", "reasoning_effort": "low", "temperature": 0.2, "top_p": 0.9, "presence_penalty": 0.1}
client = lc.LLMClient(api_key="k")
body_cases.append({"settings": None, "raw_profile": profile_with_sampling, "json": False, "override": None,
                   "body": client._build_body(profile_with_sampling, messages, False, None)})
G["llm_build_body"] = body_cases

G["llm_estimated_cost"] = [
    [m, n, lc.ModelSettings(model=m).estimated_cost(n)]
    for m in list(config.MODEL_CHOICES) + ["unknown/model"] for n in (3, 5, 10, 20)
]
G["llm_settings_as_dict"] = [
    [sv, lc.ModelSettings(**sv).as_dict(), lc.ModelSettings(**sv).label, lc.ModelSettings(**sv).supports_sampling]
    for sv in settings_variants if sv
]
del config.MODEL_CHOICES["test/sampling-model"]

usage_payloads = [
    {"usage": {"prompt_tokens": 40, "completion_tokens": 1200, "completion_tokens_details": {"reasoning_tokens": 900}}},
    {"usage": {"prompt_tokens": 10, "completion_tokens": 6400}},
    {"usage": {"prompt_tokens": None, "completion_tokens": 900, "completion_tokens_details": None}},
    {},
    None,
    {"usage": None},
]
usage = lc.Usage()
usage_steps = []
for p in usage_payloads:
    usage.add(p)
    usage_steps.append({"payload": p, "state": {**usage.__dict__, "total_tokens": usage.total_tokens}})
G["llm_usage"] = usage_steps


def payload(content, finish_reason, **extra):
    return {"choices": [{"message": {"content": content}, "finish_reason": finish_reason}], **extra}


extract_cases = [
    payload("A complete answer.", "stop"),
    payload("  padded  ", "stop"),
    payload("", "length"),
    payload('{"scores": {"Context": 7, "Techni', "length"),
    payload("", "stop"),
    payload(None, "stop"),
    {"choices": []},
    {"choices": [], "error": {"message": "Upstream exploded"}},
    {"error": {"code": 1}},
    {"choices": [{"finish_reason": "stop"}]},
]
G["llm_extract_text"] = [[p, attempt(lc.LLMClient._extract_text, p)] for p in extract_cases]

json_cases = [
    '{"a": 1}',
    '```json\n{"a": 1}\n```',
    '```\n{"a": [1, 2]}\n```',
    'Sure! Here you go: {"a": {"b": "c}"}} Hope that helps.',
    'noise { not json } then {"ok": true}',
    '[1, 2, 3]',
    '[{"a": 1}]',
    '{"s": "escaped \\" quote {"}',
    'no json at all',
    '{"unterminated": ',
    '```JSON {"x": 1} ```',
    '   \n {"x": "😀"} \n',
    '{"a": 1} {"b": 2}',
]
G["llm_parse_json"] = [[c, attempt(lc.parse_json_object, c)] for c in json_cases]


class FakeResponse:
    def __init__(self, status, body=None, text=None):
        self.status_code = status
        self._body = body
        self.text = text if text is not None else (json.dumps(body) if body is not None else "")

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


def ok_payload(content="Done."):
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3}}


retry_scripts = {
    "ok_first_time": [FakeResponse(200, ok_payload())],
    "429_then_ok": [FakeResponse(429, {"error": {"message": "slow down"}}), FakeResponse(200, ok_payload())],
    "500_500_500": [FakeResponse(500, {"error": {"message": "boom"}})] * 3,
    "network_then_ok": ["NETWORK", FakeResponse(200, ok_payload())],
    "network_x3": ["NETWORK"] * 3,
    "json_mode_rejected": [FakeResponse(400, {"error": {"message": "response_format json not supported"}}), FakeResponse(200, ok_payload('{"a": 1}'))],
    "reasoning_rejected": [FakeResponse(400, {"error": {"message": "Unknown parameter: reasoning"}}), FakeResponse(200, ok_payload())],
    "temperature_rejected": [FakeResponse(400, {"error": {"message": "temperature is not supported"}}), FakeResponse(200, ok_payload())],
    "400_other": [FakeResponse(400, {"error": {"message": "bad messages"}})],
    "401": [FakeResponse(401, {"error": {"message": "No auth"}})],
    "402": [FakeResponse(402, {"error": {"message": "Out of credit"}})],
    "404": [FakeResponse(404, None, text="<html>not found</html>")],
    "200_not_json": [FakeResponse(200, None, text="<html>")],
    "error_not_dict": [FakeResponse(418, {"error": "teapot"})],
    "error_missing": [FakeResponse(418, {"detail": "x"})],
    "error_message_empty": [FakeResponse(418, {"error": {"message": "", "code": 9}})],
    "strip_three_times": [
        FakeResponse(400, {"error": {"message": "response_format json unsupported"}}),
        FakeResponse(400, {"error": {"message": "reasoning unsupported"}}),
        FakeResponse(400, {"error": {"message": "top_p unsupported"}}),
    ],
    "long_error": [FakeResponse(400, None, text="x" * 1000)],
}


def run_retry(name, script, json_mode):
    queue = list(script)
    bodies, sleeps = [], []

    def fake_post(url, headers=None, json=None, timeout=None):
        bodies.append({"url": url, "headers": headers, "body": json, "timeout": timeout})
        item = queue.pop(0)
        if item == "NETWORK":
            raise requests.ConnectionError("connection refused")
        return item

    orig_post, orig_sleep = lc.requests.post, lc.time.sleep
    lc.requests.post, lc.time.sleep = fake_post, sleeps.append
    try:
        client = lc.LLMClient(api_key="sk-test")
        client.settings = lc.ModelSettings(model="openai/gpt-5-mini", reasoning_effort="low", max_tokens=5000, seed=None)
        result = attempt(client.chat, [{"role": "user", "content": "q"}], "evaluation", json_mode=json_mode)
        return {"name": name, "json": json_mode, "result": result, "requests": bodies, "sleeps": sleeps,
                "usage": {**client.usage.__dict__}}
    finally:
        lc.requests.post, lc.time.sleep = orig_post, orig_sleep


G["llm_retries"] = [run_retry(n, s, jm) for n, s in retry_scripts.items() for jm in (False, True)]
G["llm_mentions"] = [[t, n, lc._mentions(t, *n)] for t, n in [("Bad JSON", ["json"]), ("", ["x"]), (None, ["x"]), ("TOP_P nope", ["temperature", "top_p"])]]


# ---------------------------------------------------------------------------
# job_scraper
# ---------------------------------------------------------------------------

urls = ["careers.example.com/jobs/1", " https://x.io ", "http://a", "localhost:3000", "https://linkedin.com/jobs/1",
        "https://www.linkedin.com/jobs/1", "https://notlinkedin.com", "HTTPS://Indeed.com/x", "ftp://example.com",
        "", "   ", "https://glassdoor.com.evil.io", "https://jobs.ziprecruiter.com/a", "example.com?q=1#frag",
        "https://user:pw@example.com:8443/p", "https://exa mple.com"]
G["scraper_urls"] = [
    [u, js.normalise_url(u), js.is_valid_url(u), js._blocked_domain(js.normalise_url(u))] for u in urls
]

FILLER = ("We are looking for a data engineer to build and maintain reliable batch and streaming pipelines, "
          "own our ingestion layer, and mentor junior colleagues. ") * 4
html_cases = {
    "main_container": f"<html><head><title>T</title></head><body><nav>Home | Jobs</nav><main><h1>Data Engineer</h1><p>{FILLER}</p></main><footer>© Acme</footer></body></html>",
    "job_description_class": f"<body><div class='sidebar'>Other jobs</div><div class='job-description-wrapper'><h2>Role</h2><ul><li>Python</li><li>SQL</li></ul><p>{FILLER}</p></div></body>",
    "short_candidate_falls_through": f"<body><article>Too short</article><main><p>{FILLER}</p></main></body>",
    "no_body_fragment": f"<title>Fragment title</title><h1>Heading</h1><p>{FILLER}</p><script>var x = 1;</script>",
    "scripts_styles_comments": f"<body><style>.a{{color:red}}</style><!-- hidden comment --><script>alert('x')</script><noscript>Enable JS</noscript><p>Visible</p><svg><text>svg text</text></svg><form><input><button>Apply</button></form><aside>Ad</aside></body>",
    "entities_nbsp": "<body><p>Caf&eacute; &amp; Bar&nbsp;&nbsp;&nbsp;Berlin &lt;remote&gt; &#8211; &#x2014; &unknown;</p></body>",
    "inline_split_words": "<body><p>Py<b>thon</b> and <i>S</i>QL</p><p>Line<br>break</p></body>",
    "blank_line_runs": "<body><p>One</p>\n\n\n\n<p>Two</p>   \n  \t \n<p>Three</p>\r\n\r\n<div> Four </div></body>",
    "uppercase_tags": f"<HTML><BODY><DIV CLASS='jobDescription'><P>{FILLER}</P></DIV></BODY></HTML>",
    "data_testid": f"<body><section data-testid='jobDescriptionText'><p>{FILLER}</p></section></body>",
    "id_content": f"<body><div id='content'><p>{FILLER}</p></div><div class='content'>second</div></body>",
    "role_main": f"<body><div role='main'><p>{FILLER}</p></div></body>",
    "german_umlauts": "<body><h1>Datenanalyst (m/w/d)</h1><p>Ihre Aufgaben:</p><ul><li>Daten modellieren – täglich</li><li>Größe: ca. 40 Mio. Zeilen</li></ul><p>😀 Wir freuen uns!</p></body>",
    "empty": "",
    "only_whitespace_body": "<body>   \n\t  </body>",
    "tabs_and_multiple_spaces": "<body><pre>  indented\t\tcode   here  </pre><p>a   b  c　d</p></body>",
    "nested_strip_tags": "<body><header><h1>Site</h1><nav><a>Link</a></nav></header><div><p>Keep me</p><footer><p>Drop me</p></footer></div></body>",
    "unclosed_tags": "<body><p>First<p>Second<li>item one<li>item two<div>Div text</body>",
    "text_after_body": "<html><body><p>Inside</p></body></html><p>After body</p>",
    "doctype_and_pi": "<!DOCTYPE html><?xml version='1.0'?><html><body><p>Hello</p></body></html>",
    "long_text": "<body>" + "<p>" + ("Word " * 20000) + "</p></body>",
    "astral_near_limit": "<body><p>" + ("a" * 39998) + "😀😀😀" + "</p></body>",
}
G["scraper_html"] = {name: {"html": html, "text": js.html_to_text(html)} for name, html in html_cases.items()}


class FakeGet:
    def __init__(self, status, text):
        self.status_code = status
        self.text = text


fetch_scripts = {
    "ok": FakeGet(200, html_cases["main_container"]),
    "404": FakeGet(404, "nope"),
    "999": FakeGet(999, "linkedin style"),
    "js_rendered": FakeGet(200, "<body><div id='root'></div><p>Loading…</p></body>"),
    "timeout": "TIMEOUT",
    "network": "NETWORK",
}


def run_fetch(url, script):
    calls = []

    def fake_get(u, headers=None, timeout=None, allow_redirects=None):
        calls.append({"url": u, "headers": headers, "timeout": timeout, "allow_redirects": allow_redirects})
        if script == "TIMEOUT":
            raise requests.Timeout("read timed out")
        if script == "NETWORK":
            raise requests.ConnectionError("no route")
        return script

    orig = js.requests.get
    js.requests.get = fake_get
    try:
        r = js.fetch_posting_text(url)
        return {"result": {**r.__dict__}, "calls": calls}
    finally:
        js.requests.get = orig


G["scraper_fetch"] = [
    {"url": u, "script": name, **run_fetch(u, s)}
    for name, s in fetch_scripts.items()
    for u in (["careers.example.com/jobs/1"] if name != "ok" else ["careers.example.com/jobs/1", "not a url", "https://linkedin.com/jobs/9"])
]

extraction_replies = [
    {
        "is_job_posting": True,
        "injection_notice": "The page asked the model to ignore its rules.",
        "job_title": "Data Engineer", "company": "Acme GmbH", "location": "Berlin, Germany",
        "employment_type": "Full-time, permanent contract (unbefristet)", "seniority": "Mid-level",
        "language_of_posting": "German", "was_translated": True,
        "original_description": "Wir suchen einen Data Engineer für unsere Pipelines.",
        "original_responsibilities": "- Pipelines bauen\n- Daten modellieren\n- Team beraten",
        "original_requirements": ["3+ Jahre Python", "Sehr gute SQL-Kenntnisse"],
        "summary": "Build and maintain batch pipelines.",
        "responsibilities": ["Own the ingestion layer", "Mentor juniors"],
        "requirements": ["3+ years Python", "Strong SQL", "Airflow"],
        "nice_to_have": ["dbt"], "tech_stack": ["Python", "Airflow", "Snowflake"], "benefits": ["Remote-friendly"],
    },
    {
        "is_job_posting": False, "extraction_note": "  Login wall  ", "job_title": "", "company": None,
        "summary": None, "responsibilities": None, "requirements": "", "tech_stack": [None, "", "  Go  ", 0, 3, True],
        "benefits": "• Gym • Lunch • Pension", "nice_to_have": ["a • b", "– dash item", "* star\r\n- next", "x•y", " ▪ square"],
        "was_translated": "false", "original_description": 0, "original_responsibilities": [], "original_requirements": None,
    },
    {},
    {"is_job_posting": None, "job_title": True, "seniority": 7.5, "location": ["Berlin"], "company": {"n": 1},
     "responsibilities": "Line one\n\nLine two\r\rLine three", "requirements": ["single"], "was_translated": 1},
]


def run_extraction(reply, page_text, url, translate):
    orig = config.TRANSLATE_JOB_DESCRIPTION
    config.TRANSLATE_JOB_DESCRIPTION = translate
    try:
        stub = StubClient([reply])
        job = js.extract_job_description(stub, page_text, url)
        return {"job": enc(job.__dict__), "sent": stub.sent, "prompt_text": job.to_prompt_text(),
                "display_title": job.display_title, "has_original": job.has_original}
    finally:
        config.TRANSLATE_JOB_DESCRIPTION = orig


page_texts = ["  Some posting text  ", "", "😀" * 5 + "x" * 50]
G["scraper_extract"] = [
    {"reply": r, "page_text": p, "url": u, "translate": t, **run_extraction(r, p, u, t)}
    for r in extraction_replies for p in page_texts[:2] for u in ("https://a.io/1", "") for t in (True, False)
][:40] + [{"reply": extraction_replies[0], "page_text": page_texts[2], "url": "", "translate": True,
           **run_extraction(extraction_replies[0], page_texts[2], "", True)}]

# A page longer than MAX_JOB_TEXT_CHARS is cut before it reaches the prompt.
_long = "😀" + "y" * 40_010
_r = run_extraction({}, _long, "", True)
G["scraper_extract_long"] = {"page_text_len": len(_long), "raw_text_len": len(_r["job"]["raw_text"]), "sent_user_tail": _r["sent"][0]["messages"][1]["content"][-60:], "prompt_text": _r["prompt_text"]}

plan_replies = [
    {"key_skills": ["Python", "SQL", {"skill": "Airflow"}, "Snowflake"],
     "interview_topics": [f"Topic number {n}" for n in range(1, 10)],
     "study_plan": [{"strategy": f"Strategy {n}", "description": f"One line {n}."} for n in range(1, 6)]},
    {"key_skills": "Python", "interview_topics": {"a": 1, "b": 2}, "study_plan": "plain"},
    {"key_skills": [{"name": "Go"}, {"topic": ""}, {"x": 1}, " SQL. ", ";;", None, 5, {"keyword": "K8s", "skill": "Kube"}] + [f"s{n}" for n in range(20)],
     "interview_topics": [], "study_plan": [{"focus": "Focus only", "description": " multi\n line \t desc "}, {"strategy": "", "description": ""}, {"description": "desc only"}, 7, None]},
    {},
]
job_for_plan = js.JobDescription(job_title="Data Engineer", company="Acme", summary="Pipelines.", requirements=["SQL"], tech_stack=["Python"])


def run_plan(reply):
    stub = StubClient([reply])
    return {"reply": reply, "plan": attempt(js.build_prep_plan, stub, job_for_plan), "sent": stub.sent}


G["scraper_plan"] = [run_plan(r) for r in plan_replies]
G["scraper_plan_type_error"] = run_plan({"key_skills": 5})

prompt_jobs = [
    js.JobDescription(),
    js.JobDescription(raw_text="R" * 7000),
    js.JobDescription(raw_text="😀" * 7000),
    js.JobDescription(job_title="T", company="C", location="L", employment_type="E", seniority="S", summary="Sum",
                      responsibilities=["r1", "r2"], requirements=["q"], nice_to_have=[], tech_stack=["Py"], benefits=["b"]),
    js.JobDescription(company="OnlyCompany", original_requirements=["x"]),
]
G["scraper_job_helpers"] = [
    {"job": enc(j.__dict__), "prompt_text": j.to_prompt_text(), "display_title": j.display_title, "has_original": j.has_original}
    for j in prompt_jobs
]


# ---------------------------------------------------------------------------
# interview
# ---------------------------------------------------------------------------

G["interview_split"] = [[t, attempt(iv.split_questions, t)] for t in [-5, 0, 1, 2, 3, 4, 5, 6, 7, 10, 19, 20, 21, 100, 5.9, "7", "x"]]
G["interview_plan"] = [[n, iv.build_question_plan(iv.InterviewSettings(num_questions=n))] for n in range(1, 23)]
G["interview_settings"] = [[n, iv.InterviewSettings(num_questions=n).as_dict()] for n in (3, 5, 8, 25)]

job_for_interview = prompt_jobs[3]
G["interview_system_prompts"] = [
    {"language": lang, "difficulty": d, "attitude": a, "num_questions": n,
     "prompt": iv.build_system_prompt(job_for_interview, iv.InterviewSettings(language=lang, difficulty=d, attitude=a, num_questions=n))}
    for lang in config.LANGUAGE_OPTIONS for d in config.DIFFICULTY_OPTIONS for a in config.ATTITUDE_OPTIONS for n in (3, 8)
]

G["interview_tidy"] = [[t, iv._tidy_question(t)] for t in [
    "Question: What is X?", "question:   Why?", "Frage: Warum?", "Interviewer: Q: Double", "Q:x", "  Question: padded",
    "What is a question: here?", "", None, "Question:", "Q: Interviewer: order matters"]]

# A whole interview, one question at a time, with every message recorded.
def run_interview(num_questions, answers):
    settings = iv.InterviewSettings(language="German", difficulty="Hard", attitude="Strict", num_questions=num_questions)
    replies = [f"Question: number {i + 1} for you?" for i in range(settings.total_questions + 1)]
    stub = StubClient(replies)
    transcript = []
    trace = []
    for i in range(settings.total_questions):
        turn = iv.next_question(stub, job_for_interview, settings, transcript)
        transcript.append(turn)
        trace.append({"awaiting": iv.awaiting_answer(transcript), "progress": list(iv.progress(transcript, settings))})
        iv.record_answer(transcript, answers[i % len(answers)])
        trace.append({"complete": iv.is_complete(transcript, settings), "progress": list(iv.progress(transcript, settings))})
    extra = attempt(iv.next_question, stub, job_for_interview, settings, transcript)
    return {"num_questions": num_questions, "answers": answers, "sent": stub.sent,
            "transcript": [enc(t.__dict__) for t in transcript], "trace": trace, "extra_question": extra}


G["interview_runs"] = [run_interview(3, ["  My answer.  ", "Second."]), run_interview(5, ["A"])]
_t = [iv.TurnRecord(1, "intro", "Q?")]
G["interview_record_errors"] = {
    "empty": attempt(iv.record_answer, [], "x"),
    "twice": (iv.record_answer(_t, "a"), attempt(iv.record_answer, _t, "b"))[1],
    "blank_answer_not_answered": iv.TurnRecord(1, "intro", "Q", answer="   ").answered,
}


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------

clamp_inputs = ["7", 7, 7.5, 6.5, 8.5, -3, 11, 10.4, "8.6", "abc", None, True, False, [], {}, "", " 9 ", "10/10", "٧", 2.4999, 1e308]
G["eval_clamp"] = [[enc(v), ev._clamp_score(v)] for v in clamp_inputs]
G["eval_one_line"] = [[enc(v), ev._one_line(v)] for v in ["Name a metric.\n Say which tool.", "  a\t\tb  ", None, "", 0, 5, True, ["x"], "x\u0085y z"]]
G["eval_as_list"] = [[enc(v), ev._as_list(v)] for v in [["a", " b ", "", None, 0, 1, "  "], "single", "  ", "", None, 5, {"a": 1}, []]]

sentence_cases = [
    "One. Two. Three. Four. Five. Six.",
    "I'd start with EXPLAIN ANALYZE to find the sequential scan. The fix was a composite index on the filtered columns. On a table of [e.g. 40 million rows] that took it from [e.g. 8 seconds] to [e.g. 40 milliseconds].",
    "Ich habe die Pipeline mit z. B. Airflow orchestriert. Der Durchsatz stieg um ca. 40 Prozent. Danach habe ich u. a. Monitoring ergänzt.",
    "Cut it? Yes! Then stop. Not this.",
    "No stop at all",
    "Dr. Smith said so. Then etc. happened. vs. that.",
    'He said "Stop." Then left. (Really.) Next one.',
    "Version 2.5 shipped. 3 teams used it. …then more.",
    "A. Schmidt led it. B. Braun helped.",
    "Ends with abbreviation e.g.",
    "Trailing spaces.   Next.   ",
    "Nested (a. b [c. d] e.) f. G.",
    "Unbalanced ) close. Next.",
    "Quote ‘inside.’ Next ‘one’.",
    "😀 Emoji start. 😀 Another. 𝐀stral upper. ａ fullwidth.",
    "Numbers ¹superscript. ²next.",
    "",
    None,
]
WORDS2 = ["I", "we", "built", "e.g.", "i.e.", "z. B.", "ca.", "Dr.", "Mr.", "the", "pipeline", "[e.g.", "3", "engineers]",
          "(see", "note.)", '"Quoted."', "‘single’", "Äpfel", "ßeta", "😀", "𝐀", "2.5", "x.", "?", "!", "...", "vs.", "u.", "a.", "No.", "7.", "–", "etc."]
for _ in range(500):
    n = rng.randint(1, 25)
    toks = []
    for _ in range(n):
        tok = rng.choice(WORDS2)
        if rng.random() < 0.25:
            tok = tok.capitalize()
        if rng.random() < 0.3:
            tok += rng.choice([".", "!", "?", ".\"", ".)", ".]", ".’"])
        toks.append(tok)
    sentence_cases.append(rng.choice([" ", "  ", "\n", " ", " \t "]).join(toks))
G["eval_sentences"] = [
    [c, ev._split_sentences(c) if isinstance(c, str) else None, ev._limit_sentences(c, 3), ev._limit_sentences(c, 1)]
    for c in sentence_cases
]

eval_replies = [
    {"scores": {"Context": 7, "Technical Knowledge": 5, "Structure": 8, "Language": 6}, "strength": "Clear.", "suggested_improvement": "Name a metric.\n Say which tool.", "improved_answer": "One. Two. Three. Four."},
    {"scores": {"context": "9", "TECHNICAL KNOWLEDGE": 12, " structure ": -1}, "strength": None, "improved_answer": None},
    {"scores": [7, 7], "strength": 5},
    {"scores": {"Context": 6.5, "Technical Knowledge": 7.5, "Structure": 2.5, "Language": 3.5}},
    {},
    {"__raise__": "The model did not return valid JSON."},
]
tech_job = prompt_jobs[3]


def run_eval(qtype, answer, reply, language):
    stub = StubClient([reply])
    turn = iv.TurnRecord(2, qtype, "How would you do it?", answer=answer)
    result = attempt(ev.evaluate_turn, stub, tech_job, turn, iv.InterviewSettings(language=language))
    return {"qtype": qtype, "answer": answer, "reply": reply, "language": language, "result": result, "sent": stub.sent}


G["eval_turns"] = [run_eval(q, a, r, lang) for q in config.RUBRICS for a in ("My answer.", None, "") for r in eval_replies[:5] for lang in ("English", "German")][:60]
G["eval_turns"] += [run_eval("technical", "x", eval_replies[5], "English")]
G["eval_failed"] = [ev.failed_evaluation(iv.TurnRecord(1, q, "Q"), "boom") for q in config.RUBRICS]


def make_transcript():
    ts = []
    types = ["intro", "technical", "technical", "technical", "behavioural", "behavioural"]
    for i, qt in enumerate(types, start=1):
        crit = list(config.RUBRICS[qt])
        scores = {c: rng.randint(0, 10) for c in crit}
        turn = iv.TurnRecord(i, qt, f"Question {i}?", answer=f"Answer {i}.")
        if i == 4:
            turn.evaluation = ev.failed_evaluation(turn, "The model hit its token limit.")
        elif i == 6:
            turn.evaluation = None
        else:
            turn.evaluation = {"question_type": qt, "criteria": crit, "scores": scores,
                               "overall": round(sum(scores.values()) / len(scores), 2) if rng.random() < 2 else 0,
                               "strength": f"S{i}", "suggested_improvement": f"I{i}", "improved_answer": f"A{i}.", "error": None}
            # use the real mean path so int-vs-float formatting matches
            from statistics import mean
            turn.evaluation["overall"] = round(mean(scores.values()), 2)
        ts.append(turn)
    return ts


aggregate_cases = []
for _ in range(25):
    tr = make_transcript()
    aggregate_cases.append({
        "transcript": [enc(t.__dict__) for t in tr],
        "overall_score": ev.overall_score(tr),
        "category_averages": ev.category_averages(tr),
        "category_overall": ev.category_overall(tr),
        "per_question_rows": ev.per_question_rows(tr),
        "digest": ev.build_results_digest(tr),
        "scored_numbers": [t.number for t in ev.scored_turns(tr)],
    })
G["eval_aggregates"] = aggregate_cases
G["eval_aggregates_empty"] = {"overall_score": ev.overall_score([]), "category_averages": ev.category_averages([]), "digest": ev.build_results_digest([])}

summary_replies = [
    {"headline": "Solid\n but unspecific.", "readiness": " Getting there ",
     "what_worked": [f"Point {n}. Extra sentence." for n in range(1, 7)],
     "suggested_improvements": [f"Fix {n}." for n in range(1, 7)], "closing_advice": "  Quantify everything.  "},
    {"what_worked": "Just one string. With two sentences.", "suggested_improvements": None, "closing_advice": None},
    {},
    {"__raise__": "Upstream failure"},
]


def run_summary(reply):
    stub = StubClient([reply])
    tr = make_transcript()
    result = ev.build_overall_summary(stub, tech_job, tr, iv.InterviewSettings(language="German"))
    return {"reply": reply, "transcript": [enc(t.__dict__) for t in tr], "result": result, "sent": stub.sent}


G["eval_summaries"] = [run_summary(r) for r in summary_replies]


def run_evaluate_all():
    replies = [eval_replies[0], {"__raise__": "cut off"}, eval_replies[3]]
    stub = StubClient(replies)
    tr = [iv.TurnRecord(1, "technical", "Q1", answer="a"), iv.TurnRecord(2, "technical", "Q2", answer="b"),
          iv.TurnRecord(3, "technical", "Q3", answer="c"),
          iv.TurnRecord(4, "intro", "Q4", answer="d", evaluation={"already": True})]
    progress = []
    ev.evaluate_all(stub, tech_job, tr, iv.InterviewSettings(), on_progress=lambda d, t: progress.append([d, t]))
    return {"transcript": [enc(t.__dict__) for t in tr], "progress": progress, "calls": len(stub.sent)}


G["eval_evaluate_all"] = run_evaluate_all()
G["eval_bands"] = [[s, ev.score_band(s), ev.score_color(s)] for s in [0, 4.99, 5, 7.99, 8, 10]]

_tr = make_transcript()
G["eval_export"] = {
    "transcript": [enc(t.__dict__) for t in _tr],
    "export": enc(ev.transcript_to_export(_tr, tech_job, iv.InterviewSettings(num_questions=6), {"headline": "h"},
                                          lc.ModelSettings(model="openai/gpt-5", seed=3))),
    "export_no_model": enc(ev.transcript_to_export(_tr, tech_job, iv.InterviewSettings(), None, None)),
}

G["tech_job"] = enc(tech_job.__dict__)
G["job_for_plan"] = enc(job_for_plan.__dict__)

out = HERE / "golden.json"
out.write_text(json.dumps(G, ensure_ascii=False, indent=1, allow_nan=False), encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size // 1024} KB) from {PY_APP}")
