/**
 * Short, honest one-liners for the setup options. Each is a summary of the
 * matching instruction in lib/prompts.ts — change one, change the other.
 */

import type { Attitude, Difficulty, Language } from "../config";

export const LANGUAGE_NOTES: Record<Language, string> = {
  English: "Professional British / International English",
  German: "Formal business German, Sie-Form",
};

export const DIFFICULTY_NOTES: Record<Difficulty, string> = {
  Easy: "Foundational questions a junior candidate should handle",
  Medium: "Applied, second-round level, the odd trade-off",
  Hard: "Senior level: ambiguity, trade-offs, failure modes",
};

export const ATTITUDE_NOTES: Record<Attitude, string> = {
  Neutral: "Businesslike and level — no praise, no criticism",
  Friendly: "Warm, reacts to something specific you said",
  Strict: "Terse and exacting; calls out vague answers",
};

export const EFFORT_NOTES = {
  minimal: "Fastest, least thinking",
  low: "Quick",
  medium: "Balanced (measured default)",
  high: "Deepest, slowest, costs most",
} as const;
