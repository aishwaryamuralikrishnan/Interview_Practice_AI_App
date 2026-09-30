# Technical notes

The interface, the project layout, what every important file does, and how to
run the app locally, how it is protected, and what to keep in step with the
Python version. For what the app does and why, see **[README.md](README.md)**.

---

## Stack

Next.js 16 (App Router) with React 19 and TypeScript, styled with Tailwind CSS 4.
Charts are drawn with Recharts, and the PDF is rendered on the server with
`@react-pdf/renderer`. Model calls go to OpenRouter over plain `fetch`. Tests
use Vitest for the logic and Playwright for the UI in a real browser.

## Run it locally (Windows)

1. Install **Node.js 22.12 or newer** from nodejs.org (the LTS installer). Check
   with `node --version` in a *new* terminal.
2. In this folder:
   ```
   npm install
   ```
   If PowerShell says *running scripts is disabled*, use `npm.cmd` in place of
   `npm` (and `npx.cmd` for `npx`), or run
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
3. Copy `.env.example` to `.env.local` and put your OpenRouter key in it:
   ```
   OPENROUTER_API_KEY=sk-or-...
   ```
   `.env.local` is git-ignored, and the key is read only on the server.
   `APP_ACCESS_CODE` is optional — see [Protection](#protection).
4. Start it:
   ```
   npm run dev
   ```
   and open http://localhost:3000. `Ctrl + C` stops it.

After pulling changes that touch `package.json`, stop the server and run
`npm install` again. If a *Module not found* error survives the install,
delete the `.next` folder (a build cache) and start again.

## Checks

```
npm test            # Vitest: logic, parity with Python, API, PDF (no key, no network)
npm run e2e         # Playwright: the whole UI in a real browser (no key, no network)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # production build
```

Before the first `npm run e2e`, download the test browser once with
`npx playwright install chromium`. Screenshots of every stage, in light and
dark, on desktop and phone: `$env:SCREENSHOTS=1; npm run e2e -- screenshots`
(PowerShell). They land in `screenshots/`.

---

## The interface

One page, five stages, with a step bar across the top.

| Stage | What you see |
|---|---|
| 1 · Job posting | A link box, or a *Paste text* tab — the app switches to it by itself when a site blocks fetching. A collapsed *Model and tuning* panel: model cards with price and trade-offs, reasoning effort, max tokens, a live cost estimate. |
| 2 · Description & plan | The posting as understood, a warning if the page tried to instruct the model, the original text when it was translated, and tabs for the description, key skills, likely topics and study plan. |
| 3 · Interview setup | Option cards for language, difficulty and interviewer attitude, each with a one-line description; a question counter with a live split preview and cost. |
| 4 · Mock interview | A chat: one question at a time, *Enter* to send, *Shift + Enter* for a new line. When the last answer is in, a progress bar tracks the scoring, one answer at a time. |
| 5 · Results | Overall and per-category scores, what worked and what to improve, a bar chart per question and a radar chart per category (with a table view), the rubric, and each answer in detail. Downloads: the PDF report and the raw data as JSON. |

Across every stage:

- **Start over** sits in the header from stage 2 on, and asks before it clears
  anything, naming what would be lost. *Practise this role again* and *Start
  over with a new job* on the results page do the same.
- **A reload resumes where you were**, mid-interview included. The session is
  kept in the tab's `sessionStorage` and is gone when the tab closes.
- **Light and dark** follow the system setting; the charts have their own
  colour steps for each. The layout works down to phone width.
- **Model text is always plain text**, never Markdown or HTML.

---

## How it fits together

```
browser (React)                     server (Route Handlers)               OpenRouter
───────────────                     ───────────────────────               ──────────
components/InterviewApp.tsx ─POST─▶ app/api/job        ─┐
  holds the whole session           app/api/question    ├ lib/api/*  ──▶ lib/llm.ts ──▶ GPT-5 family
  (lib/client/state.ts)             app/api/evaluate    │ validate,
                                    app/api/summary    ─┘ then run
                                    app/api/report  ─── lib/server/report.tsx → PDF, no model call
```

The browser holds the session and sends each endpoint only what that call
needs. The server rebuilds every field from that untrusted JSON before it
reaches a prompt (`lib/api/validate.ts`), and the API key is read in exactly
one server-only file, so it never reaches the page.

## Where the code is, stage by stage

| Stage | Code |
|---|---|
| 1 · Model and tuning | `components/stages/ModelPanel.tsx` → `ModelSettings` in `lib/llm.ts` |
| 1 · Job link or text | `components/stages/PostingStage.tsx` → `POST /api/job` → `fetchPostingText` in `lib/scraper.ts` |
| 2 · Structured posting | `extractJobDescription` in `lib/scraper.ts` |
| 2 · Skills, topics, study plan | `buildPrepPlan` in `lib/scraper.ts`; shown by `components/stages/ReviewStage.tsx` |
| 3 · Interview setup | `components/stages/SetupStage.tsx` → `splitQuestions` in `lib/interview.ts` |
| 4 · One question at a time | `components/stages/InterviewStage.tsx` → `POST /api/question` → `nextQuestion` in `lib/interview.ts` |
| 5 · Scoring | `POST /api/evaluate` → `evaluateTurn`, then `POST /api/summary` → `buildOverallSummary`, both in `lib/evaluation.ts` |
| 5 · Results and charts | `components/stages/ResultsStage.tsx`, `components/charts.tsx` |
| 5 · PDF | `POST /api/report` → `buildReport` in `lib/server/report.tsx` |
| Every model call | `LLMClient.chat` / `.chatJson` in `lib/llm.ts` |

## Files

```
app/
  layout.tsx                  The HTML shell and page title
  page.tsx                    The one page: renders InterviewApp
  globals.css                 Tailwind, and the colour tokens for light and dark
  api/job/route.ts            POST: fetch or take a posting, extract it, build the plan
  api/question/route.ts       POST: the next interview question
  api/evaluate/route.ts       POST: score one answer
  api/summary/route.ts        POST: the closing summary
  api/report/route.ts         POST: the PDF report, as a download
  api/login/route.ts          POST: check the access code, set the cookie
  api/session/route.ts        GET: is a code needed, and has this browser entered it

components/
  InterviewApp.tsx            Header, step bar, Start over, and the session reducer
  AccessGate.tsx              The access-code screen, when one is configured
  stages/PostingStage.tsx     Stage 1: link or pasted text
  stages/ModelPanel.tsx       Stage 1: model choice, effort, max tokens, cost
  stages/ReviewStage.tsx      Stage 2: the posting and the preparation plan
  stages/SetupStage.tsx       Stage 3: language, difficulty, attitude, length
  stages/InterviewStage.tsx   Stage 4: the chat, and the scoring that follows it
  stages/ResultsStage.tsx     Stage 5: the report on screen, and the downloads
  charts.tsx                  Per-question bars and per-category radars
  ui.tsx                      Buttons, cards, alerts, tabs, option cards, icons

lib/                          The logic — ported from the Python modules
  config.ts                   Developer settings: models, bounds, rubrics, colours
  prompts.ts                  Every prompt, word for word from prompts.py
  llm.ts                      OpenRouter client: retries, truncation guard, JSON parsing, usage
  job.ts                      The posting's data type and its pure helpers
  scraper.ts                  Fetch and clean a page, extract the posting, build the plan
  interview.ts                Question split and plan, one question at a time
  evaluation.ts               Scoring, sentence cap, averages, summary, JSON export
  py.ts, pyUnicode.ts         Python behaviour the port must match (rounding, whitespace, …)
  api/job.ts                  The /api/job logic, free of Next.js so it can be tested
  api/interview.ts            The /api/question, /evaluate and /summary logic
  api/report.ts               The /api/report logic
  api/settings.ts             Validates the model settings the browser sends
  api/validate.ts             Rebuilds job, transcript and summary from untrusted JSON
  client/state.ts             The session reducer, and reload protection
  client/api.ts               The browser's calls to the endpoints
  client/format.ts            Score, price and link formatting for display
  client/copy.ts              One-line descriptions of the setup options
  server/openrouter.ts        The only place the API key is read (server-only)
  server/access.ts            Access code and rate limits, checked first by every route
  server/ratelimit.ts         The in-memory sliding-window rate limiter
  server/netguard.ts          Fetches posting links without reaching private networks
  server/report.tsx           The PDF report: layout, fonts, filename
  server/fontCoverage.ts      Which characters the PDF font can draw (generated)
  server/fonts/               Noto Sans, with its licence (OFL.txt)

tests/                        Vitest — no key, no network
  parity.test.ts              Replays parity/golden.json: the Python app's recorded behaviour
  behaviour.test.ts           fake_run.py's logic checks: guardrails, caps, a full interview
  api.test.ts                 Every outcome of /api/job
  interview-api.test.ts       Every outcome of /api/question, /evaluate, /summary
  report.test.ts              The PDF: sections, pages, characters, failed answers
  state.test.ts               The session reducer
  netguard.test.ts            The private-network guard, redirects included
  access.test.ts              The access code and every rate limit
  helpers.ts                  A scripted model and a scripted web page

e2e/                          Playwright — the UI in a real browser
  flow.spec.ts                A full interview, Start over, reload, blocked links, PDF, access code
  mockApi.ts                  Stands in for the model inside the browser
  screenshots.spec.ts         Saves a screenshot of every stage (opt-in)

parity/generate.py            Records the Python app's behaviour into golden.json
parity/gen_unicode_tables.py  Generates lib/pyUnicode.ts from Python itself
scripts/gen_font_coverage.py  Generates lib/server/fontCoverage.ts from the fonts
docs/                         Diagrams used by README.md, with their HTML sources
```

## Protection

Three safeguards, all on the server, so a public deployment can't be misused:

- **Links can't reach private networks.** A posting link is fetched by the
  server, so a link like `http://169.254.169.254/` would otherwise make the
  server fetch its own cloud metadata or internal services (server-side request
  forgery). `lib/server/netguard.ts` refuses private, loopback, link-local and
  reserved addresses — checked on the connection itself, so a hostile DNS
  answer can't slip past, and again at every redirect hop.
- **Rate limits, always on** (`lib/server/access.ts`). Each visitor, by IP
  address, gets 100 model calls, 15 postings and 30 PDFs an hour, and 10
  access-code attempts per 15 minutes; everyone together gets 1,000 model calls
  an hour. One 20-question interview is 43 calls. The counts are kept in
  memory, so they are per server instance and reset on a restart — a guard
  against casual abuse, with the spending limit on the OpenRouter key as the
  hard cap behind it.
- **An optional access code.** Set `APP_ACCESS_CODE` and the app asks for it
  before anything else; the API refuses every call without it. Leave it unset
  and the app is open, as it is locally. Changing the code signs everyone out.
  The browser keeps only a cookie derived from the code, never the code itself.

### Deploying on Vercel

Set these under the project's *Settings → Environment Variables*:

| Variable | Needed | What it is |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | Your OpenRouter key |
| `APP_ACCESS_CODE` | no | The code visitors must enter; leave unset for an open demo |

## Matching the Python app

`tests/parity.test.ts` replays `parity/golden.json`, a recording of what the
Python app does for hundreds of inputs — including every prompt it sends — and
requires the TypeScript to produce the same output. Where this version differs
on purpose, the test says so beside the case.

Matching it means copying some Python behaviour that JavaScript does
differently. `lib/py.ts` holds these, and each one changes real output:

- **Rounding.** Python rounds 6.5 to 6 (to the even number); `Math.round`
  gives 7, which would quietly raise scores.
- **Whitespace.** Python's `strip()` and `split()` use a different character
  set from `trim()` and `\s`. The table in `lib/pyUnicode.ts` is generated
  from Python itself.
- **Length.** Python counts characters; JavaScript's `.length` counts UTF-16
  units, so an emoji is 1 in one and 2 in the other. The text caps must count
  the same way.
- **Turning model output into numbers and text.** `float()`, `int()`, `str()`
  and `bool()` accept and reject different things from `Number()`,
  `parseInt()` and `String()`. Models sometimes return scores as strings, so
  the port cleans them exactly as Python does.
- **Prompt templates.** The prompts keep Python's `{placeholder}` form and are
  filled by `pyFormat`, so they can be compared with `prompts.py` directly.

## Maintenance notes

- **Prompts are copied, not edited.** `lib/prompts.ts` keeps the wording of
  `prompts.py` exactly, including a few typos ("stragery", "theoritical",
  "understandings") and a trailing space in `PREP_PLAN_USER`. Fix them in both
  apps together, then regenerate `golden.json`, so the parity test keeps
  meaning something.
- **The setup option descriptions** in `lib/client/copy.ts` summarise the
  difficulty and attitude instructions in `lib/prompts.ts`. Change one, change
  the other.
- **Fonts.** `lib/server/fonts/` holds Noto Sans, under the SIL Open Font
  License (`OFL.txt` beside the files).
- **Unicode tables** in `lib/pyUnicode.ts` were generated with Python 3.11; the
  Python app pins 3.10. Whitespace is identical between the two; 3.11 knows a
  few more digit sets, which matters only if a model writes a score in one.
- **Node 22.12 or newer** is required by Vitest and is set in `package.json`.

## Regenerating generated files

- **`parity/golden.json`** — only after changing the *Python* app. With Python
  3.10+ and the Python app's requirements installed, `npm run parity` runs
  `parity/generate.py` against `../interview_preparation_app`, with the model
  and network stubbed.
- **`lib/server/fontCoverage.ts`** — only after changing the fonts:
  `python scripts/gen_font_coverage.py` (needs `fonttools`).
