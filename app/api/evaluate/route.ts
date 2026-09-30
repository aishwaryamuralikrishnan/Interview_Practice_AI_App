/**
 * POST /api/evaluate — Score one answer (one model call).
 * The logic and validation live in lib/api/interview.ts; this only supplies
 * the server-side client and turns the result into a Response.
 */

import { handleEvaluateRequest } from "@/lib/api/interview";
import { createServerClient } from "@/lib/server/openrouter";
import { guardRequest } from "@/lib/server/access";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Access code and rate limits first: a refused request costs nothing.
  const refused = guardRequest(request, "evaluate");
  if (refused) return refused;

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ ok: false, stage: "input", error: "The request body must be JSON." }, { status: 400 });
  }
  const { status, body } = await handleEvaluateRequest(input, { makeClient: createServerClient });
  return Response.json(body, { status });
}
