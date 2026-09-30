"use client";

/**
 * Model choice and tuning, collected in step 1 and used for every call.
 * Collapsed to a one-line summary until opened — most people keep the default.
 */

import { useId, useState } from "react";

import * as config from "@/lib/config";
import { estimatedCost, modelLabel, type ModelSettings } from "@/lib/llm";
import { EFFORT_NOTES } from "@/lib/client/copy";
import { formatInt, formatUsd } from "@/lib/client/format";
import type { UsageTotals } from "@/lib/client/api";
import { Chip, cx, Icon, OptionCards, Segmented } from "../ui";

export default function ModelPanel({
  settings,
  onChange,
  usage,
}: {
  settings: ModelSettings;
  onChange: (settings: ModelSettings) => void;
  usage: UsageTotals;
}) {
  const [open, setOpen] = useState(false);
  const tokensId = useId();
  const tempId = useId();
  const spec = config.MODEL_CHOICES[settings.model];
  const estimate = estimatedCost(settings, config.DEFAULT_QUESTIONS);
  const set = (patch: Partial<ModelSettings>) => onChange({ ...settings, ...patch });

  return (
    <section className="rounded-2xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left"
      >
        <span className="inline-flex size-9 items-center justify-center rounded-xl bg-surface-2 text-ink-2">
          <Icon name="settings" className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">Model and tuning</span>
          <span className="block truncate text-xs text-ink-2">
            {modelLabel(settings)} · {settings.reasoning_effort || "default"} effort · about {formatUsd(estimate)} per{" "}
            {config.DEFAULT_QUESTIONS}-question session
          </span>
        </span>
        <Icon name="chevron" className={cx("size-4 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-6 border-t border-line px-5 pt-5 pb-6">
          <OptionCards
            label="Model"
            options={Object.keys(config.MODEL_CHOICES)}
            value={settings.model}
            onChange={(model) => set({ model })}
            render={(model) => {
              const m = config.MODEL_CHOICES[model];
              return (
                <span className="block space-y-2">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{m.label}</span>
                    <Chip className="py-0 text-[11px]">{m.tag}</Chip>
                  </span>
                  <span className="flex gap-2 text-xs text-ink-2">
                    <Icon name="check" className="mt-0.5 size-3.5 text-good" />
                    {m.advantage}
                  </span>
                  <span className="flex gap-2 text-xs text-ink-2">
                    <Icon name="alert" className="mt-0.5 size-3.5 text-ink-3" />
                    {m.disadvantage}
                  </span>
                  <span className="block pt-1 text-[11px] text-ink-3 tabular-nums">
                    ${m.price_in.toFixed(2)} in · ${m.price_out.toFixed(2)} out per million tokens
                  </span>
                </span>
              );
            }}
          />

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <Segmented
                label="Reasoning effort"
                options={config.REASONING_EFFORT_OPTIONS}
                value={settings.reasoning_effort || config.DEFAULT_REASONING_EFFORT}
                onChange={(reasoning_effort) => set({ reasoning_effort })}
                describe={(o) => EFFORT_NOTES[o]}
              />
              <p className="mt-2 text-xs text-ink-2">
                How much the model thinks before answering — the GPT-5 family&apos;s replacement for temperature. It
                changes depth, not randomness. Higher costs more and is slower.
              </p>
            </div>

            <div>
              <label htmlFor={tokensId} className="mb-2 flex items-baseline justify-between text-sm font-medium text-ink">
                Max tokens per response
                <span className="text-sm font-semibold tabular-nums">{formatInt(settings.max_tokens)}</span>
              </label>
              <input
                id={tokensId}
                type="range"
                min={config.MAX_TOKENS_MIN}
                max={config.MAX_TOKENS_MAX}
                step={config.MAX_TOKENS_STEP}
                value={settings.max_tokens}
                onChange={(e) => set({ max_tokens: Number(e.target.value) })}
                className="w-full accent-[var(--accent)]"
              />
              <p className="mt-2 text-xs text-ink-2">
                A ceiling, not a spend — you pay for what is generated. It also covers the model&apos;s hidden
                reasoning, so too low a value returns an empty answer.
              </p>
            </div>
          </div>

          {config.modelSupportsSampling(settings.model) ? (
            <div>
              <label htmlFor={tempId} className="mb-2 flex items-baseline justify-between text-sm font-medium text-ink">
                Temperature
                <span className="font-semibold tabular-nums">{settings.temperature.toFixed(1)}</span>
              </label>
              <input
                id={tempId}
                type="range"
                min={config.TEMPERATURE_MIN}
                max={config.TEMPERATURE_MAX}
                step={config.TEMPERATURE_STEP}
                value={settings.temperature}
                onChange={(e) => set({ temperature: Number(e.target.value) })}
                className="w-full accent-[var(--accent)]"
              />
            </div>
          ) : (
            <p className="rounded-xl bg-surface-2 px-4 py-3 text-xs text-ink-2">
              <span className="font-semibold text-ink">Temperature isn&apos;t available for {spec?.label}.</span>{" "}
              OpenRouter lists no temperature, top_p or verbosity parameter for any GPT-5 model — they are rejected.
              Reasoning effort is the knob that replaces it.
            </p>
          )}

          <p className="text-xs text-ink-2">
            A {config.DEFAULT_QUESTIONS}-question session — the whole run, from reading the posting to scoring the
            answers — costs roughly <span className="font-semibold text-ink">{formatUsd(estimate)}</span> on this model.
            Measured at medium effort; higher effort costs more.
          </p>

          {config.SHOW_DEVELOPER_PANEL && <DeveloperPanel settings={settings} onChange={onChange} usage={usage} />}
        </div>
      )}
    </section>
  );
}

/** A debugging aid, off by default (config.SHOW_DEVELOPER_PANEL). */
function DeveloperPanel({
  settings,
  onChange,
  usage,
}: {
  settings: ModelSettings;
  onChange: (settings: ModelSettings) => void;
  usage: UsageTotals;
}) {
  const fixed = settings.seed !== null;
  return (
    <div className="space-y-3 rounded-xl border border-dashed border-line-strong p-4 text-xs text-ink-2">
      <p className="font-semibold text-ink">Developer settings</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={fixed}
          onChange={(e) => onChange({ ...settings, seed: e.target.checked ? config.DEFAULT_SEED : null })}
        />
        Fix the seed
      </label>
      {fixed && (
        <input
          type="number"
          aria-label="Seed"
          min={0}
          max={2 ** 31 - 1}
          value={settings.seed ?? config.DEFAULT_SEED}
          onChange={(e) => onChange({ ...settings, seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          className="w-40 rounded-lg border border-line-strong bg-surface px-2 py-1 text-ink"
        />
      )}
      <p>
        Makes an identical request return an identical response (best effort) — for A/B-testing a prompt edit, not
        for practice.
      </p>
      <p className="tabular-nums">
        {usage.calls} API calls · {formatInt(usage.total_tokens)} tokens ({formatInt(usage.reasoning_tokens)} reasoning) ·
        largest single response {formatInt(usage.peak_completion_tokens)} tokens
      </p>
    </div>
  );
}
