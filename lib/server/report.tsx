/**
 * The PDF report — the port of report_pdf.py.
 *
 * Same content, same order as the Python report: the headline and overall
 * score, what worked / suggested improvements, the closing advice, what the
 * criteria mean, then one block per answer in the 1-2-3-4 format. Rendered on
 * the server with @react-pdf/renderer and returned as bytes.
 *
 * One deliberate improvement: the Python report used PDF base-14 fonts
 * (cp1252 only), so "Łódź" printed as "Lodz". This embeds Noto Sans, which
 * draws Latin, Greek and Cyrillic properly. What even Noto Sans can't draw
 * (CJK, emoji) is folded to ASCII or dropped — the Python rule, applied to a
 * much smaller set of characters — so the PDF never shows an empty box.
 */

import "server-only";

import path from "node:path";

import { Document, Font, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";

import * as config from "../config";
import { categoryOverall, overallScore, scoreBand, scoreColor, type OverallSummary } from "../evaluation";
import { counts, typeLabel, type InterviewSettings, type TurnRecord } from "../interview";
import { displayTitle, type JobDescription } from "../job";
import { modelLabel, type ModelSettings } from "../llm";
import { FONT_RANGES } from "./fontCoverage";

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const FONT_DIR = path.join(process.cwd(), "lib", "server", "fonts");
const FAMILY = "Noto Sans";

Font.register({
  family: FAMILY,
  fonts: [
    { src: path.join(FONT_DIR, "NotoSans-Regular.ttf") },
    { src: path.join(FONT_DIR, "NotoSans-Bold.ttf"), fontWeight: 700 },
    { src: path.join(FONT_DIR, "NotoSans-Italic.ttf"), fontStyle: "italic" },
  ],
});
// No automatic hyphenation: a report should not break "Snowflake" as "Snow-flake".
Font.registerHyphenationCallback((word) => [word]);

function drawable(cp: number): boolean {
  let lo = 0;
  let hi = FONT_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = FONT_RANGES[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

// Readable substitutes for the few common symbols the font lacks.
const REPLACEMENTS: Record<string, string> = { "→": "->", "←": "<-", "\t": "    ", "\r": "" };

/**
 * Make text drawable by the embedded font. A character the font has is kept;
 * one it lacks is folded to its ASCII base letter if it has one, else dropped.
 */
export function pdfSafe(value: unknown): string {
  const text = String(value ?? "");
  let out = "";
  for (const ch of text) {
    if (ch === "\n") {
      out += ch;
      continue;
    }
    if (REPLACEMENTS[ch] !== undefined) {
      out += REPLACEMENTS[ch];
      continue;
    }
    if (drawable(ch.codePointAt(0)!)) {
      out += ch;
      continue;
    }
    out += ch.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Styles — the PDF is always light-on-white; it is printed, not themed.
// ---------------------------------------------------------------------------

const ACCENT = config.ACCENT_COLORS.light;
const INK = "#0b0b0b";
const MUTED = "#52514e";
const FAINT = "#6f6e69";
const RULE = "#d9d8d2";
const PANEL = "#f5f5f2";
const CATEGORY = config.CATEGORY_COLORS.light;

const s = StyleSheet.create({
  page: { fontFamily: FAMILY, fontSize: 9.5, color: INK, paddingTop: 44, paddingBottom: 52, paddingHorizontal: 50 },
  // No lineHeight on the page or any container: a page-number Text that
  // inherits one is silently not drawn (a @react-pdf/renderer 4.9 quirk), so
  // each text style sets its own — always with its fontSize beside it, since
  // a multiplier is resolved against the style's own size (default 18pt).
  content: {},
  footerLeft: { position: "absolute", bottom: 24, left: 50, right: 150, fontSize: 7.5, color: FAINT },
  footerRight: { position: "absolute", bottom: 24, left: 400, right: 50, fontSize: 7.5, color: FAINT, textAlign: "right" },
  title: { fontSize: 20, fontWeight: 700, lineHeight: 1.25, marginBottom: 6 },
  meta: { fontSize: 8.5, color: MUTED, lineHeight: 1.5 },
  rule: { borderBottomWidth: 0.7, borderBottomColor: RULE, marginTop: 12, marginBottom: 14 },
  h2: { fontSize: 13, fontWeight: 700, lineHeight: 1.3, color: ACCENT, marginTop: 18, marginBottom: 7 },
  h3: { fontSize: 10.5, fontWeight: 700, lineHeight: 1.35, marginTop: 10, marginBottom: 4 },
  body: { fontSize: 9.5, lineHeight: 1.45, marginBottom: 4 },
  label: { fontSize: 7.5, fontWeight: 700, color: FAINT, letterSpacing: 0.6, marginTop: 8, marginBottom: 3 },
  quote: { fontSize: 9.5, lineHeight: 1.45, fontStyle: "italic", paddingLeft: 9, borderLeftWidth: 2, borderLeftColor: RULE, marginBottom: 2 },
  improved: { fontSize: 9.5, lineHeight: 1.45, padding: 9, backgroundColor: "#eef4fc", borderRadius: 4, borderWidth: 0.6, borderColor: "#c8dcf5" },
  bulletRow: { flexDirection: "row", marginBottom: 3 },
  bullet: { width: 11, color: FAINT, fontSize: 9.5, lineHeight: 1.45 },
  bulletText: { flex: 1, fontSize: 9.5, lineHeight: 1.45 },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  row: { flexDirection: "row", alignItems: "center" },
});

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function fmt(score: number): string {
  return String(Math.round(score * 100) / 100);
}

function Bullets({ items }: { items: string[] }) {
  return (
    <View>
      {items.map((item, i) => (
        <View key={i} style={s.bulletRow} wrap={false}>
          <Text style={s.bullet}>•</Text>
          <Text style={s.bulletText}>{pdfSafe(item)}</Text>
        </View>
      ))}
    </View>
  );
}

function Dot({ color }: { color: string }) {
  return <View style={[s.dot, { backgroundColor: color }]} />;
}

function Hero({ transcript, summary }: { transcript: TurnRecord[]; summary: Partial<OverallSummary> }) {
  const overall = overallScore(transcript);
  const byCategory = categoryOverall(transcript);
  return (
    <View style={{ flexDirection: "row", gap: 14 }} wrap={false}>
      <View style={{ width: 120, padding: 12, backgroundColor: PANEL, borderRadius: 6 }}>
        <Text style={{ fontSize: 7.5, fontWeight: 700, color: FAINT, letterSpacing: 0.6 }}>OVERALL SCORE</Text>
        <Text style={{ fontSize: 28, fontWeight: 700, marginTop: 2, lineHeight: 1.2 }}>
          {fmt(overall)}
          <Text style={{ fontSize: 12, fontWeight: 400, color: FAINT }}> / {config.SCORE_MAX}</Text>
        </Text>
        <View style={[s.row, { marginTop: 4 }]}>
          <Dot color={scoreColor(overall)} />
          <Text style={{ fontWeight: 700, fontSize: 9 }}>{config.SCORE_BAND_LABELS[scoreBand(overall)]}</Text>
        </View>
        {summary.readiness ? <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 2 }}>{pdfSafe(summary.readiness)}</Text> : null}
      </View>
      <View style={{ flex: 1, paddingTop: 2 }}>
        {summary.headline ? <Text style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.35, marginBottom: 8 }}>{pdfSafe(summary.headline)}</Text> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {config.QUESTION_TYPES.filter((t) => byCategory[t] !== undefined).map((t) => (
            <View key={t} style={{ flex: 1, padding: 8, borderWidth: 0.6, borderColor: RULE, borderRadius: 5 }}>
              <View style={s.row}>
                <Dot color={CATEGORY[t]} />
                <Text style={{ fontSize: 8, color: MUTED }}>{config.QUESTION_TYPE_LABELS[t]}</Text>
              </View>
              <Text style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3, marginTop: 2 }}>
                {fmt(byCategory[t]!)}
                <Text style={{ fontSize: 8.5, fontWeight: 400, color: FAINT }}> / {config.SCORE_MAX}</Text>
              </Text>
              <Text style={{ fontSize: 7.5, color: MUTED }}>{config.SCORE_BAND_LABELS[scoreBand(byCategory[t]!)]}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function ScoreTable({ turn }: { turn: TurnRecord }) {
  const e = turn.evaluation!;
  const cells: [string, string, boolean][] = [
    ["OVERALL", `${fmt(e.overall)} / ${config.SCORE_MAX}`, true],
    ...Object.entries(e.scores).map(([name, value]): [string, string, boolean] => [name.toUpperCase(), `${value} / ${config.SCORE_MAX}`, false]),
  ];
  return (
    <View style={{ flexDirection: "row", borderWidth: 0.6, borderColor: RULE, borderRadius: 4 }} wrap={false}>
      {cells.map(([label, value, overall], i) => (
        <View
          key={label}
          style={{ flex: 1, padding: 6, borderLeftWidth: i ? 0.6 : 0, borderLeftColor: RULE, backgroundColor: overall ? PANEL : undefined }}
        >
          <Text style={{ fontSize: 6.5, color: FAINT, letterSpacing: 0.4 }}>{pdfSafe(label)}</Text>
          <View style={[s.row, { marginTop: 1 }]}>
            {overall ? <Dot color={scoreColor(e.overall)} /> : null}
            <Text style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.3 }}>{value}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function Answer({ turn, last }: { turn: TurnRecord; last: boolean }) {
  const e = turn.evaluation;
  const heading = (
    <View style={[s.row, { marginTop: 10, marginBottom: 2 }]} minPresenceAhead={120}>
      <Dot color={CATEGORY[turn.question_type]} />
      <Text style={{ fontSize: 10.5, fontWeight: 700, lineHeight: 1.35 }}>
        Q{turn.number} | {typeLabel(turn)}
        {e && !e.error ? ` | ${fmt(e.overall)}/${config.SCORE_MAX}` : ""}
      </Text>
    </View>
  );

  if (!e || e.error) {
    return (
      <View wrap={false}>
        {heading}
        <Text style={s.body}>{pdfSafe(`This answer could not be scored: ${e?.error ?? "no evaluation"}`)}</Text>
      </View>
    );
  }

  // Keep a whole answer on one page where it fits; a very long one may split.
  const length = turn.question.length + (turn.answer ?? "").length + e.improved_answer.length;
  return (
    <View wrap={length > 1800}>
      {heading}
      <Text style={s.label} minPresenceAhead={30}>1. QUESTION</Text>
      <Text style={s.body}>{pdfSafe(turn.question)}</Text>
      <Text style={s.label} minPresenceAhead={30}>2. PROVIDED ANSWER</Text>
      <Text style={s.quote}>{pdfSafe(turn.answer || "(no answer given)")}</Text>
      <Text style={s.label} minPresenceAhead={40}>3. SCORES</Text>
      <ScoreTable turn={turn} />
      {e.suggested_improvement ? (
        <Text style={{ marginTop: 6, fontSize: 9.5, lineHeight: 1.45 }}>
          <Text style={{ fontWeight: 700 }}>Suggested improvement: </Text>
          {pdfSafe(e.suggested_improvement)}
        </Text>
      ) : null}
      <Text style={s.label} minPresenceAhead={30}>4. STRONGER VERSION OF THE ANSWER</Text>
      <Text style={s.improved}>{pdfSafe(e.improved_answer || "-")}</Text>
      {!last ? <View style={[s.rule, { marginTop: 12, marginBottom: 2, borderBottomWidth: 0.4 }]} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface ReportInput {
  job: JobDescription;
  interview: InterviewSettings;
  transcript: TurnRecord[];
  summary: Partial<OverallSummary> | null;
  modelSettings: ModelSettings | null;
  generatedAt?: Date;
  timeZone?: string;
}

function generatedLabel(date: Date, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone };
  return new Intl.DateTimeFormat("en-GB", opts).format(date).replace(" at ", ", ");
}

function Report({ job, interview, transcript, summary, modelSettings, generatedAt = new Date(), timeZone }: ReportInput) {
  const sum = summary ?? {};
  const c = counts(interview);
  const title = `Interview report - ${displayTitle(job)}`;
  const worked = sum.what_worked ?? [];
  const improvements = sum.suggested_improvements ?? [];

  return (
    <Document title={pdfSafe(title)} author={config.PAGE_TITLE} creator={config.PAGE_TITLE} producer={config.PAGE_TITLE}>
      <Page size="A4" style={s.page}>
        <Text style={s.footerLeft} fixed>
          {pdfSafe(title)}
        </Text>
        <Text style={s.footerRight} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />

        <View style={s.content}>
          <Text style={s.title}>Interview report</Text>
          <Text style={s.meta}>
            {pdfSafe(displayTitle(job))} | {interview.language} | {interview.difficulty} | {interview.attitude} interviewer |{" "}
            {interview.num_questions} questions ({c.intro} intro, {c.technical} technical, {c.behavioural} behavioural)
          </Text>
          <Text style={s.meta}>
            Generated {generatedLabel(generatedAt, timeZone)}
            {modelSettings
              ? ` | ${pdfSafe(modelLabel(modelSettings))}${modelSettings.reasoning_effort ? `, ${modelSettings.reasoning_effort} reasoning effort` : ""}`
              : ""}
          </Text>
          <View style={s.rule} />

          <Hero transcript={transcript} summary={sum} />

          {worked.length || improvements.length ? (
            <View style={{ flexDirection: "row", gap: 18, marginTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={s.h3}>What worked</Text>
                <Bullets items={worked} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.h3}>Suggested improvements</Text>
                <Bullets items={improvements} />
              </View>
            </View>
          ) : null}

          {sum.closing_advice ? (
            <View wrap={false}>
              <Text style={s.h2}>Before the real thing</Text>
              <Text style={s.body}>{pdfSafe(sum.closing_advice)}</Text>
            </View>
          ) : null}

          <Text style={s.h2} minPresenceAhead={80}>How each answer was scored</Text>
          <Text style={s.body}>
            Every answer is marked out of {config.SCORE_MAX} on the four criteria for its question type.
          </Text>
          {config.QUESTION_TYPES.map((t) => (
            <View key={t} wrap={false}>
              <View style={[s.row, { marginTop: 8, marginBottom: 3 }]}>
                <Dot color={CATEGORY[t]} />
                <Text style={{ fontSize: 10.5, fontWeight: 700, lineHeight: 1.35 }}>{config.QUESTION_TYPE_LABELS[t]}</Text>
              </View>
              {Object.entries(config.RUBRICS[t]).map(([name, description]) => (
                <View key={name} style={s.bulletRow}>
                  <Text style={s.bullet}>•</Text>
                  <Text style={s.bulletText}>
                    <Text style={{ fontWeight: 700 }}>{name}</Text> - {description}
                  </Text>
                </View>
              ))}
            </View>
          ))}

          {/* -- answer by answer, from a fresh page ------------------------ */}
          <View break>
            <Text style={[s.h2, { marginTop: 0 }]}>Deep analysis for each answer provided</Text>
            {transcript.map((turn, i) => (
              <Answer key={turn.number} turn={turn} last={i === transcript.length - 1} />
            ))}
          </View>
        </View>
      </Page>
    </Document>
  );
}

/** Render the whole report and return the PDF as bytes. */
export function buildReport(input: ReportInput): Promise<Buffer> {
  return renderToBuffer(<Report {...input} />);
}

/** A tidy, filesystem-safe name for the download — as suggested_filename() made it. */
export function suggestedFilename(job: JobDescription, date = new Date(), timeZone?: string): string {
  let stem = job.job_title || "interview";
  if (job.company) stem = `${stem} ${job.company}`;
  stem = stem
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
  return `${stem || "interview"}-report-${parts.replaceAll("-", "")}.pdf`;
}
