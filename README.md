# Interview Practice AI

A web app that turns a job posting into interview preparation: it reads
the posting, builds a study plan, runs a mock interview of your chosen length
one question at a time, then scores and rewrites every answer.

You choose which model does the work — three are offered, from a cheap fast one
to the most capable — and how hard it should think. Postings that aren't in
English are translated automatically, with the original kept alongside.

### At a glance

| | |
|---|---|
| **Try it** | **Live app on Vercel** _(link to be added)_ · run it locally with [TECHNICAL.md](TECHNICAL.md) |
| **What it does** | Turns a real job posting into a study plan, a mock interview and a scored report with a stronger version of every answer |
| **Cost per session** | About 3 cents for a five-question interview on GPT-5 mini |
| **Interview** | English or German · 3 to 20 questions · three difficulty levels · three interviewer styles |
| **Stack** | Next.js 16 · React 19 · TypeScript · Tailwind CSS · Recharts · OpenRouter (GPT-5, GPT-5 mini, GPT-5 nano) |

*Screenshot from the app: one answer from a real results report, scored and rewritten.*

<img src="docs/05_results_analysis.png" alt="Scored self-introduction: four rubric scores, a suggested improvement, and a stronger version with bracketed placeholders for facts only the candidate can supply" width="700">

Setup, commands and the file layout live in **[TECHNICAL.md](TECHNICAL.md)**.

---

## How it works

![The five stages of the app](docs/workflow.png)

*Screenshot from the app: the posting read, translated and turned into a study plan.*

<img src="docs/02_description_and_plan.png" alt="Study plan built from a German StepStone posting, translated, with 12 key skills, 6 likely topics and 3 plan items" width="700">

<!--*Screenshot from the app: choosing how the mock interview will run.*

<img src="docs/03_interview_setup.png" alt="Interview setup: language, difficulty, interviewer attitude and a 5-question split of 1 introduction, 2 technical, 2 behavioural" width="600">-->

## From Python to TypeScript

The app was first built in Python with a Streamlit interface, then migrated to
TypeScript as a Next.js web app, for four reasons:

- **A full-stack portfolio** — the same project shown as JavaScript work, not
  only Python.
- **A better interface** — free of Streamlit's rerun-everything model, the
  interview runs as a real conversation, one question at a time, in a layout
  built for the web and for phones.
- **The API key stays on the server** — every model call runs in a server-side
  route, so the key never reaches the browser.
- **Surviving a page reload** — an interview in progress picks up where it
  stopped instead of being lost.

---

## Choosing a model

All three are the same family, so the difference is depth and price, not
behaviour. Prices are US dollars per million tokens.

| Model | Input | Output | A 5-question session | Best when |
|---|---|---|---|---|
| **GPT-5 nano** | $0.05 | $0.40 | ~$0.01 | You're testing the app itself, or practising in bulk |
| **GPT-5 mini** | $0.25 | $2.00 | ~$0.03 | The default — strong reasoning at low cost |
| **GPT-5** | $1.25 | $10.00 | ~$0.14 | The interview that actually matters |

The same model does every job, so these prices apply to both halves of the app
— the job description analysis and the interview simulation.

The step between each is 5×. Nano's weakness shows up as shallower feedback and
looser scoring rather than as visible errors, which makes it easy to
over-trust — worth knowing when you compare two runs.

The session figures are measured at medium effort, so treat them as a floor.
Two things push the real figure up — a very long posting makes the reading step
more expensive, and higher reasoning effort generates more of the invisible
thinking you pay for.

## What you can tune

![The two tuning dials, and the one that does not exist](docs/tuning.png)

## Prompting

Almost every prompt is **zero-shot** — an instruction with no worked example —
because reasoning models follow direct instructions well, and OpenAI's own
guidance is to try zero-shot first and add examples only where it fails.
**Few-shot** appears in exactly one place, the scoring prompt, where three
worked examples show what a 3, a 6 and a 9 look like; calibration is a
judgment problem rather than a knowledge problem, and words like "5 = average"
mean different things to different models. **Chain-of-thought is deliberately
absent**: these models reason internally before answering, so asking them to
"think step by step" is redundant and can make results worse. The
reasoning-effort dial is the chain-of-thought control here.

## What comes back from the model

Four of the five calls ask for a **JSON object**; only the interview question
comes back as plain text.

| Call | Comes back as | Why |
|---|---|---|
| Read the posting | JSON | Fields the app files into a structure: title, requirements, tech stack |
| Skills, topics, study plan | JSON | Three separate lists that render as three separate cards |
| **Ask a question** | **plain text** | It is one spoken sentence that goes straight into the conversation — there is nothing to structure |
| Score an answer | JSON | Numbers the app must bound, and text it must place in specific slots |
| Closing summary | JSON | A verdict, two capped lists, and closing advice |

The reason is control. When the model returns prose, the app can only display
it; when it returns named fields, the app decides where each one goes and can
check it first — a score outside 0–10 is clamped, an over-long rewrite is
trimmed, a missing field falls back. That is why the report's layout never
breaks no matter what the model does, and it is the same principle as the
guardrails below: **anything that can be enforced in code is enforced in code,
not asked for in a prompt.**

Here is what a single answer's scoring returns:

```json
{
  "scores": {
    "Context": 7,
    "Technical Knowledge": 5,
    "Structure": 8,
    "Language": 6
  },
  "strength": "Named the right tool and gave the steps in a sensible order.",
  "suggested_improvement": "Name the tool you used and the size of the dataset.",
  "improved_answer": "I'd start with EXPLAIN ANALYZE to find the sequential scan. On our [40-million-row] orders table the fix was a composite index, which took it from [8 seconds] to [40 milliseconds]. I'd only cache after that, since caching a slow query hides the problem."
}
```

## Interview length

You choose how many questions you want, between 3 and 20. The first is always a
self-introduction; the rest split evenly between technical and behavioural,
with the odd one going to technical — so 5 questions means 1 intro, 2 technical
and 2 behavioural. Three is the shortest interview that still includes one of
every type.

## How your answers are scored

![The rubric and the shape of the report](docs/evaluation.png)

The whole report downloads as a PDF that mirrors the screen — the same summary,
the same rubric, the same four-part block per answer. Charts are not embedded,
because every number in them appears as text anyway.

## Guardrails

![Three guardrails and where they live](docs/guardrails.png)

Three prompt-level guards, each at a seam where untrusted text meets the model:

| # | Guard | Stops |
|---|---|---|
| 1 | Lawful questions only | practice questions about age, pregnancy, family status, nationality, ethnic origin, religion, disability, gender or sexual identity — the characteristics protected by §1 AGG |
| 2 | Untrusted input | a poisoned job page giving orders to the model; detected attempts surface as a warning on the review page |
| 3 | Evidence, not instruction | an answer that tells the assessor what to score it — such text is graded as the non-answer it is |

Guard 1 binds every persona and difficulty, and it supplies the lawful
reformulation ("Do you hold a Class C licence?") rather than only a prohibition.

**These reduce risk; they do not eliminate it.** Prompt injection has no
reliable prompt-level fix. What caps the damage is structural: the model has no
tools and can only emit text, and every score and string it returns is bounded
before anything uses it.

## Destructive actions

Four buttons throw away work that cannot be reconstructed — **Start over** at
the top of the page, **End without scoring** during the interview, and
**Practise this role again** and **Start over with a new job** on the results
page. All four ask twice, with a warning naming what is at stake, and
mid-interview that warning counts the answers you would lose.
**Start over** is hidden on the first screen, where there is nothing to clear.

---

## Known limits

- LinkedIn, Indeed and Glassdoor block automated fetching, and some career
  sites render the posting in JavaScript. The app says so and offers a paste
  box; everything downstream is identical.
- The person answering is also the person being scored, so this is a
  self-practice tool. It is not safe as an assessment tool, where the candidate
  would have something to gain from influencing the grader.
- Your answers are sent to the model provider, and the JSON export contains all
  of them in plain text.

---

## Future scope

**Systematic evaluation instead of manual.** Scoring quality is currently judged
by hand — run an interview, read the feedback, form an opinion. That does not
scale and it does not settle arguments. An LLM-as-a-judge harness such as
DeepEval would turn it into a repeatable suite, so a prompt change could be
measured rather than eyeballed. It is also the only honest way to answer the
question the code cannot answer today: whether the few-shot calibration anchors
actually improve scoring, or just cost tokens.

**Voice-to-text for the mock interview.** Interviews are spoken, not typed.
Answering out loud would make the practice closer to the real thing, and would
expose the hesitation, filler and rambling that a typed answer quietly edits
away — precisely the things the Clarity and Structure criteria are meant to
catch. ElevenLabs' voice models could cover both directions: speech-to-text
for the spoken answer, and text-to-speech to give the interviewer a voice.

**Memory across sessions, using RAG.** Storing past answers and retrieving the
relevant ones would let the interviewer build on a story you have already told,
and let the assessor check a claim against what you said last time. This is the
one place retrieval genuinely earns its keep. A single job posting already fits
in the context window whole, so there is nothing to select between — but a
growing history of your own answers does not, and that is exactly the problem
embeddings and retrieval exist to solve. I have already built this retrieval
pattern in another project of mine, the
[German Bureaucracy Navigator](https://github.com/aishwaryamuralikrishnan/German_Bureaucracy_Navigator),
a RAG application.
