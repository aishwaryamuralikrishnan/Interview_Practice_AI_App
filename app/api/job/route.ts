/**
 * POST /api/job — read a posting and build the preparation plan.
 *
 * Body: { "url": "https://…" }  or  { "text": "…pasted posting…" }
 *       optionally "settings": { model, reasoning_effort, max_tokens, seed }
 *
 * The browser only ever talks to this endpoint. The OpenRouter key is read in
 * lib/server/openrouter.ts, which is server-only; it never leaves the server.
 */

import { handleJobRequest } from "@/lib/api/job";
import { createServerClient } from "@/lib/server/openrouter";
import { guardRequest } from "@/lib/server/access";

// Two model calls with reasoning can take a while. Honoured by hosts that
// read it (Vercel does); harmless locally.
export const maxDuration = 300;

export async function POST(request: Request) {
  // Access code and rate limits first: a refused request costs nothing.
  const refused = guardRequest(request, "job");
  if (refused) return refused;

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ ok: false, stage: "input", error: "The request body must be JSON." }, { status: 400 });
  }
  const { status, body } = await handleJobRequest(input, { makeClient: createServerClient });
  return Response.json(body, { status });
}
