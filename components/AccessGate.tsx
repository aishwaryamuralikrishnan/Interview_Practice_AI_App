"use client";

/**
 * Shown instead of the app when the server has an access code configured
 * (APP_ACCESS_CODE) and this browser hasn't entered it yet.
 */

import { useState, type FormEvent } from "react";

import { login } from "@/lib/client/api";
import { Alert, Button, Card, Icon } from "./ui";

export default function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    const res = await login(code);
    setBusy(false);
    if (res.ok) onUnlocked();
    else setError(res.error);
  }

  return (
    <div className="mx-auto max-w-md pt-6 sm:pt-12">
      <Card className="p-6 sm:p-8">
        <span className="inline-flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name="shield" className="size-5" />
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Enter the access code</h1>
        <p className="mt-2 text-sm text-ink-2">
          This app is protected so its model budget can&apos;t be used up by strangers. Ask the person who shared the
          link for the code.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="access-code" className="mb-2 block text-sm font-medium text-ink">
              Access code
            </label>
            <input
              id="access-code"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              className="h-12 w-full rounded-xl border border-line-strong bg-surface px-4 text-base text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          {error && <Alert tone="error" title={error} />}
          <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!code.trim()} className="w-full">
            Continue
          </Button>
        </form>
      </Card>
    </div>
  );
}
