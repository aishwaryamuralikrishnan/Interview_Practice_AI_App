/**
 * The PDF report — the port of fake_run.py's run_pdf_checks, plus the route.
 * Text is read back out of the PDF with unpdf, as the Python test used pypdf.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";

import * as config from "@/lib/config";
import { handleReportRequest } from "@/lib/api/report";
import { parseEvaluation } from "@/lib/api/validate";
import { failedEvaluation } from "@/lib/evaluation";
import { defaultInterviewSettings, type TurnRecord } from "@/lib/interview";
import { emptyJob } from "@/lib/job";
import { defaultModelSettings } from "@/lib/llm";
import { buildReport, pdfSafe, suggestedFilename } from "@/lib/server/report";

const job = emptyJob({
  job_title: "Data Engineer",
  company: "Acme GmbH",
  location: "Berlin",
  summary: "Pipelines.",
  requirements: ["3+ years Python"],
});
const interview = defaultInterviewSettings({ language: "German", difficulty: "Hard", attitude: "Strict", num_questions: 3 });

function transcript(): TurnRecord[] {
  return (["intro", "technical", "behavioural"] as const).map((type, i) => ({
    number: i + 1,
    question_type: type,
    question: "Erzählen Sie — was haben Sie getan?",
    answer: "Ich habe eine Pipeline gebaut — mit Airflow.",
    evaluation: parseEvaluation(
      {
        scores: Object.fromEntries(Object.keys(config.RUBRICS[type]).map((c) => [c, 7])),
        strength: "Klar.",
        suggested_improvement: "Nennen Sie eine Zahl.",
        // Characters outside the font must not crash or box out.
        improved_answer: "Ich habe […] gebaut — 日本 Łódź ćма →",
      },
      type,
      "e",
    ),
  }));
}

const summary = {
  headline: "Solide.",
  readiness: "Getting there",
  what_worked: ["Klar strukturiert."],
  suggested_improvements: ["Zahlen nennen."],
  closing_advice: "Üben Sie STAR.",
  error: null,
};

async function read(pdf: Buffer) {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return { pages: doc.numPages, text: text as string };
}

describe("the PDF report", () => {
  it("builds a real, paginated PDF with every section", async () => {
    const pdf = await buildReport({ job, interview, transcript: transcript(), summary, modelSettings: defaultModelSettings() });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);

    const { pages, text } = await read(pdf);
    expect(pages).toBeGreaterThanOrEqual(2);
    for (const needle of [
      "Interview report",
      "Deep analysis for each answer provided",
      "How each answer was scored",
      "1. QUESTION",
      "2. PROVIDED ANSWER",
      "Suggested improvements",
      "Before the real thing",
      "Erzählen", // umlauts survive
      "Łódź", // and so does Polish, which the Python report had to fold to "Lodz"
      "GPT-5 mini",
      "Page 1 of",
    ]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).not.toContain("日本");
  });

  it("still builds when every answer failed to score", async () => {
    const failed = transcript().map((t) => ({ ...t, evaluation: failedEvaluation(t, "API exploded") }));
    const pdf = await buildReport({ job, interview, transcript: failed, summary: {}, modelSettings: null });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await read(pdf)).text).toContain("This answer could not be scored: API exploded");
  });

  it("keeps what the font can draw and folds or drops the rest", () => {
    expect(pdfSafe("Łódź — “quoted” … €5")).toBe("Łódź — “quoted” … €5");
    expect(pdfSafe("a → b")).toBe("a -> b");
    expect(pdfSafe("日本 ok 🎯")).toBe(" ok ");
    expect(pdfSafe("line one\nline two")).toBe("line one\nline two");
  });

  it("suggests a filesystem-safe filename", () => {
    const name = suggestedFilename(job, new Date("2026-09-30T10:00:00Z"), "UTC");
    expect(name).toBe("data-engineer-acme-gmbh-report-20260930.pdf");
    expect(suggestedFilename(emptyJob({ job_title: "C++ / Qt @ Łódź!" }), new Date("2026-01-02T00:00:00Z"), "UTC")).toBe(
      "c-qt-d-report-20260102.pdf",
    );
  });
});

describe("POST /api/report", () => {
  const body = () => ({ job, interview, transcript: transcript(), summary, settings: defaultModelSettings(), timeZone: "Europe/Berlin" });

  it("returns the PDF and its filename", async () => {
    const result = await handleReportRequest(body(), new Date("2026-09-30T23:30:00Z"));
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Named by the viewer's date, not the server's: 01:30 on 1 October in Berlin.
    expect(result.filename).toBe("data-engineer-acme-gmbh-report-20261001.pdf");
  });

  it("refuses an unfinished interview", async () => {
    const result = await handleReportRequest({ ...body(), transcript: transcript().slice(0, 2) });
    expect(result.status).toBe(409);
  });

  it("rejects malformed input", async () => {
    for (const bad of [{ timeZone: "Mars/Olympus" }, { summary: { what_worked: "x" } }, { interview: { ...interview, num_questions: 0 } }]) {
      const result = await handleReportRequest({ ...body(), ...bad });
      expect(result.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("serves it as a download through the route", async () => {
    const { POST } = await import("@/app/api/report/route");
    const response = await POST(new Request("http://localhost/api/report", { method: "POST", body: JSON.stringify(body()) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="data-engineer-acme-gmbh-report-\d{8}\.pdf"$/);
  });
});
