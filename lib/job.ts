/**
 * The posting as the rest of the app sees it — the data type and its pure
 * helpers, split out of scraper.ts so that code running in the browser can
 * use them without bundling the HTML parser (cheerio) that scraper.ts needs.
 * scraper.ts re-exports everything here, so imports from either work.
 */

import { cpSlice, pyTruthy } from "./py";

/**
 * Structured posting, plus the raw text it came from.
 *
 * A plain object — not a class — so it survives JSON between the Route
 * Handler and the browser unchanged. The Python methods are the functions
 * below it.
 */
export interface JobDescription {
  raw_text: string;
  source_url: string;
  is_job_posting: boolean;
  extraction_note: string | null;
  /**
   * Set when the page contained text trying to instruct the model rather than
   * describe a job. Surfaced to the user — a guard you cannot see is not much
   * of a guard.
   */
  injection_notice: string | null;
  job_title: string | null;
  company: string | null;
  location: string | null;
  employment_type: string | null;
  seniority: string | null;
  language_of_posting: string | null;
  was_translated: boolean;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  nice_to_have: string[];
  tech_stack: string[];
  benefits: string[];
  // Untranslated originals, kept only when the posting was translated.
  original_description: string;
  original_responsibilities: string[];
  original_requirements: string[];
}

export function emptyJob(overrides: Partial<JobDescription> = {}): JobDescription {
  return {
    raw_text: "",
    source_url: "",
    is_job_posting: true,
    extraction_note: null,
    injection_notice: null,
    job_title: null,
    company: null,
    location: null,
    employment_type: null,
    seniority: null,
    language_of_posting: null,
    was_translated: false,
    summary: "",
    responsibilities: [],
    requirements: [],
    nice_to_have: [],
    tech_stack: [],
    benefits: [],
    original_description: "",
    original_responsibilities: [],
    original_requirements: [],
    ...overrides,
  };
}

export function hasOriginal(job: JobDescription): boolean {
  return Boolean(
    job.original_description || job.original_responsibilities.length || job.original_requirements.length,
  );
}

export function displayTitle(job: JobDescription): string {
  const parts = [job.job_title || "Job posting"];
  if (job.company) parts.push(`@ ${job.company}`);
  return parts.join(" ");
}

/** A compact rendering of the posting, fed into every later prompt. */
export function toPromptText(job: JobDescription): string {
  const lines: string[] = [];

  const add = (label: string, value: string | string[] | null) => {
    if (!pyTruthy(value)) return;
    if (Array.isArray(value)) {
      lines.push(`${label}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${label}: ${value}`);
    }
  };

  add("Job title", job.job_title);
  add("Company", job.company);
  add("Location", job.location);
  add("Employment type", job.employment_type);
  add("Seniority", job.seniority);
  add("Summary", job.summary);
  add("Responsibilities", job.responsibilities);
  add("Requirements", job.requirements);
  add("Nice to have", job.nice_to_have);
  add("Tech stack", job.tech_stack);

  if (lines.length === 0) return cpSlice(job.raw_text, 6000);
  return lines.join("\n");
}

export interface StudyStrategy {
  strategy: string;
  description: string;
}

export interface PrepPlan {
  key_skills: string[];
  interview_topics: string[];
  study_plan: StudyStrategy[];
}
