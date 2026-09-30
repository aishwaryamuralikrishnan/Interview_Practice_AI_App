"use client";

/**
 * The handful of UI primitives every stage is built from. Styling only —
 * no app logic lives here.
 */

import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

import { SCORE_BAND_LABELS, SCORE_MAX, type QuestionType } from "@/lib/config";
import { scoreBand } from "@/lib/evaluation";
import { formatScore } from "@/lib/client/format";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Icons — inline strokes, so there is no icon dependency and they inherit
// currentColor.
// ---------------------------------------------------------------------------

const ICONS = {
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  paste: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9z",
  check: "M20 6 9 17l-5-5",
  chevron: "m6 9 6 6 6-6",
  arrowRight: "M5 12h14M13 5l7 7-7 7",
  arrowLeft: "M19 12H5M11 19l-7-7 7-7",
  alert: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  printer: "M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z",
  refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  tag: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01",
  chat: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
  plan: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  doc: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  sparkle: "M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z",
  x: "M18 6 6 18M6 6l12 12",
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("shrink-0", className)}
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("animate-spin shrink-0", className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover shadow-sm",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-bad text-white hover:brightness-110 shadow-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  icon,
  iconRight,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  icon?: IconName;
  iconRight?: IconName;
}) {
  const sizes = { sm: "h-8 px-3 text-sm gap-1.5", md: "h-10 px-4 text-sm gap-2", lg: "h-12 px-5 text-base gap-2" };
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-55",
        sizes[size],
        VARIANTS[variant],
        className,
      )}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconRight && !busy ? <Icon name={iconRight} /> : null}
    </button>
  );
}

/**
 * A destructive action behind a second click, as in the Streamlit app: the
 * first click only explains what will be lost. Nothing here is undoable.
 */
export function ConfirmButton({
  label,
  warning,
  confirmLabel,
  onConfirm,
  variant = "secondary",
  icon,
  className,
}: {
  label: string;
  warning: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: Variant;
  icon?: IconName;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant={variant} icon={icon} onClick={() => setAsking(true)} className={className}>
        {label}
      </Button>
    );
  }
  return (
    <div role="alertdialog" aria-label={label} className="rounded-xl border border-warn/50 bg-warn-soft p-3 text-sm">
      <p className="mb-3 text-ink">{warning}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setAsking(false)} autoFocus>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]", className)}>{children}</div>;
}

export function CardHeader({ icon, title, meta }: { icon?: IconName; title: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      {icon && (
        <span className="inline-flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name={icon} className="size-[18px]" />
        </span>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {meta && <span className="ml-auto text-sm text-ink-3">{meta}</span>}
    </div>
  );
}

type Tone = "info" | "warn" | "error" | "success";

const TONES: Record<Tone, { box: string; icon: IconName; iconColor: string }> = {
  info: { box: "border-accent/30 bg-accent-soft", icon: "info", iconColor: "text-accent" },
  warn: { box: "border-warn/50 bg-warn-soft", icon: "alert", iconColor: "text-[#b07800] dark:text-warn" },
  error: { box: "border-bad/40 bg-bad-soft", icon: "alert", iconColor: "text-bad" },
  success: { box: "border-good/40 bg-good-soft", icon: "check", iconColor: "text-good" },
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border p-4 text-sm", t.box, className)}>
      <Icon name={t.icon} className={cx("mt-0.5 size-[18px]", t.iconColor)} />
      <div className="min-w-0 flex-1 space-y-1 text-ink">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-ink-2 [&_p+p]:mt-1">{children}</div>}
        {action && <div className="pt-2">{action}</div>}
      </div>
    </div>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-ink-2", className)}>
      {children}
    </span>
  );
}

const CATEGORY_DOT: Record<QuestionType, string> = {
  intro: "bg-cat-intro",
  technical: "bg-cat-technical",
  behavioural: "bg-cat-behavioural",
};

/** Identity comes from the coloured dot; the text stays in ink. */
export function CategoryDot({ type, className = "size-2" }: { type: QuestionType; className?: string }) {
  return <span className={cx("inline-block shrink-0 rounded-full", CATEGORY_DOT[type], className)} aria-hidden="true" />;
}

const BAND_DOT = { strong: "bg-good", ok: "bg-warn", weak: "bg-bad" } as const;

/** Score, band dot and band label together — colour never carries the meaning alone. */
export function ScorePill({ score, className }: { score: number; className?: string }) {
  const band = scoreBand(score);
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-ink whitespace-nowrap", className)}>
      <span className={cx("size-2 rounded-full", BAND_DOT[band])} aria-hidden="true" />
      {formatScore(score)} / {SCORE_MAX} · {SCORE_BAND_LABELS[band]}
    </span>
  );
}

export function BandDot({ score, className = "size-2.5" }: { score: number; className?: string }) {
  return <span className={cx("inline-block rounded-full", BAND_DOT[scoreBand(score)], className)} aria-hidden="true" />;
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Choice controls
// ---------------------------------------------------------------------------

/** A compact single-choice row. Arrow keys move between options, as a radio group should. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  describe,
  hideLabel,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  describe?: (option: T) => string;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <p id={id} className={cx("mb-2 text-sm font-medium text-ink", hideLabel && "sr-only")}>
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} className="inline-flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1">
        {options.map((option, i) => {
          const selected = option === value;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              title={describe?.(option)}
              onClick={() => onChange(option)}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = options[(i + step + options.length) % options.length];
                onChange(next);
                (e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement | undefined)?.focus();
              }}
              className={cx(
                "rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                selected ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Option cards: a radio group whose options each carry a line of explanation. */
export function OptionCards<T extends string>({
  label,
  options,
  value,
  onChange,
  render,
  columns = "sm:grid-cols-3",
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  render: (option: T, selected: boolean) => ReactNode;
  columns?: string;
}) {
  const id = useId();
  return (
    <div>
      <p id={id} className="mb-2 text-sm font-medium text-ink">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} className={cx("grid gap-2", columns)}>
        {options.map((option, i) => {
          const selected = option === value;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option)}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = options[(i + step + options.length) % options.length];
                onChange(next);
                (e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement | undefined)?.focus();
              }}
              className={cx(
                "relative flex flex-col items-start justify-start rounded-xl border p-3 text-left transition-colors",
                selected ? "border-accent bg-accent-soft ring-1 ring-accent" : "border-line bg-surface hover:border-line-strong",
              )}
            >
              {render(option, selected)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs and disclosure
// ---------------------------------------------------------------------------

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    // overflow-y-hidden, and an inset underline instead of a border pulled over
    // the container's: otherwise a 1px vertical overflow shows scroll arrows on Windows.
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line">
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = tabs[(i + step + tabs.length) % tabs.length];
              onChange(next.id);
              document.getElementById(`tab-${next.id}`)?.focus();
            }}
            className={cx(
              "flex items-center gap-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
              selected ? "text-ink shadow-[inset_0_-2px_0_var(--accent)]" : "text-ink-2 hover:text-ink",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={cx("rounded-full px-1.5 text-xs tabular-nums", selected ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-3")}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="pt-5">
      {children}
    </div>
  );
}

/** Controlled disclosure — controlled so print can open every one. */
export function Disclosure({
  summary,
  children,
  open,
  onToggle,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex w-full items-center gap-3 text-left"
      >
        <div className="min-w-0 flex-1">{summary}</div>
        <Icon name="chevron" className={cx("size-4 text-ink-3 transition-transform print:hidden", open && "rotate-180")} />
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export function BulletList({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cx("space-y-2", className)}>
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed text-ink">
          <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-ink-3" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function NumberedList({ items }: { items: { heading: string; description?: string }[] }) {
  return (
    <ol className="space-y-4">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent">
            {i + 1}
          </span>
          <div className="text-sm leading-relaxed">
            <p className="font-semibold text-ink">{item.heading}</p>
            {item.description && <p className="text-ink-2">{item.description}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
