"use client";

/**
 * The two results charts, each doing one job (as charts.py did):
 *   QuestionBars  — magnitude per question, identity by category colour
 *   CriteriaRadar — the shape of one category's rubric profile
 *
 * Colours are CSS variables from globals.css, so light and dark each use
 * their own validated steps. Text is always ink, never the series colour;
 * identity comes from the mark and the legend.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { QUESTION_TYPE_LABELS, QUESTION_TYPES, SCORE_MAX, type QuestionType } from "@/lib/config";
import type { QuestionRow } from "@/lib/evaluation";
import { formatScore, truncate } from "@/lib/client/format";
import { CategoryDot } from "./ui";

const CATEGORY_VAR: Record<QuestionType, string> = {
  intro: "var(--cat-intro)",
  technical: "var(--cat-technical)",
  behavioural: "var(--cat-behavioural)",
};

const TICK = { fill: "var(--ink-2)", fontSize: 12 };

// ---------------------------------------------------------------------------

export function QuestionBars({ rows }: { rows: QuestionRow[] }) {
  const present = QUESTION_TYPES.filter((t) => rows.some((r) => r.question_type === t));
  return (
    <figure>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <figcaption className="text-sm font-semibold text-ink">Score per question (out of {SCORE_MAX})</figcaption>
        {/* Legend: always present for more than one category. */}
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend">
          {present.map((t) => (
            <li key={t} className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-[3px]" style={{ background: CATEGORY_VAR[t] }} aria-hidden="true" />
              {QUESTION_TYPE_LABELS[t]}
            </li>
          ))}
        </ul>
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 24, right: 8, bottom: 0, left: -20 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--chart-axis)" }} tick={TICK} />
            <YAxis domain={[0, SCORE_MAX]} ticks={[0, 2, 4, 6, 8, 10]} tickLine={false} axisLine={false} tick={{ ...TICK, fill: "var(--ink-3)", fontSize: 11 }} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<BarTip />} isAnimationActive={false} />
            <Bar dataKey="score" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.number} fill={CATEGORY_VAR[r.question_type]} />
              ))}
              <LabelList dataKey="score" position="top" formatter={(v: unknown) => formatScore(Number(v))} fill="var(--ink)" fontSize={12} fontWeight={600} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function BarTip({ active, payload }: { active?: boolean; payload?: { payload: QuestionRow }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="max-w-64 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <p className="text-sm font-semibold text-ink tabular-nums">
        {formatScore(row.score)} <span className="font-normal text-ink-3">of {SCORE_MAX}</span>
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-ink-2">
        <CategoryDot type={row.question_type} />
        {row.label} · {row.type_label}
      </p>
      <p className="mt-1 text-ink-3">{truncate(row.question, 120)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Break a long criterion name at its most balanced space, as charts.py did. */
function wrapLabel(name: string, limit = 13): string[] {
  if (name.length <= limit || !name.includes(" ")) return [name];
  const words = name.split(" ");
  let best = 1;
  let bestGap = Infinity;
  for (let cut = 1; cut < words.length; cut++) {
    const gap = Math.abs(words.slice(0, cut).join(" ").length - words.slice(cut).join(" ").length);
    if (gap < bestGap) {
      best = cut;
      bestGap = gap;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

interface AngleTickProps {
  x?: number | string;
  y?: number | string;
  cy?: number;
  textAnchor?: string;
  payload?: { value: string };
  scores: Record<string, number>;
}

/**
 * The criterion's name with its value underneath. The value lives in the
 * label rather than on the marker, where it collided with the polygon.
 */
function AngleTick({ x = 0, y = 0, cy = 0, textAnchor = "middle", payload, scores }: AngleTickProps) {
  const name = payload?.value ?? "";
  const lines = wrapLabel(name);
  const nx = Number(x);
  const ny = Number(y);
  const rows = lines.length + 1;
  // Grow away from the centre: upward above it, downward below it.
  const top = ny < cy - 4 ? ny - (rows - 1) * 13 : ny > cy + 4 ? ny + 4 : ny - ((rows - 1) * 13) / 2;
  return (
    <text x={nx} y={top} textAnchor={textAnchor as "start" | "middle" | "end"} fontSize={11}>
      {lines.map((line, i) => (
        <tspan key={i} x={nx} dy={i === 0 ? 4 : 13} fill="var(--ink-2)">
          {line}
        </tspan>
      ))}
      <tspan x={nx} dy={13} fill="var(--ink)" fontWeight={700} fontSize={12}>
        {formatScore(scores[name] ?? 0)}
      </tspan>
    </text>
  );
}

export function CriteriaRadar({ type, scores }: { type: QuestionType; scores: Record<string, number> }) {
  const data = Object.entries(scores).map(([criterion, value]) => ({ criterion, value }));
  const color = CATEGORY_VAR[type];
  return (
    <figure className="min-w-0">
      {/* One series, so no legend: the title names it. */}
      <figcaption>
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CategoryDot type={type} className="size-2.5" />
          {QUESTION_TYPE_LABELS[type]}
        </span>
        <span className="block text-xs text-ink-3">Average by criterion, out of {SCORE_MAX}</span>
      </figcaption>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="62%" margin={{ top: 24, right: 36, bottom: 24, left: 36 }}>
            <PolarGrid stroke="var(--chart-grid)" />
            <PolarAngleAxis dataKey="criterion" tick={<AngleTick scores={scores} />} />
            <PolarRadiusAxis domain={[0, SCORE_MAX]} tickCount={6} tick={false} axisLine={false} />
            <Radar
              dataKey="value"
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.18}
              dot={{ r: 4, fill: color, stroke: "var(--surface)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Tooltip content={<RadarTip />} isAnimationActive={false} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function RadarTip({ active, payload }: { active?: boolean; payload?: { payload: { criterion: string; value: number } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <p className="text-sm font-semibold text-ink tabular-nums">
        {formatScore(p.value)} <span className="font-normal text-ink-3">of {SCORE_MAX}</span>
      </p>
      <p className="text-ink-2">{p.criterion}</p>
    </div>
  );
}
