/**
 * POST /api/report — download the interview report as a PDF.
 * Validation and rendering live in lib/api/report.ts and lib/server/report.tsx.
 */

import { handleReportRequest } from "@/lib/api/report";
import { guardRequest } from "@/lib/server/access";

export async function POST(request: Request) {
  // Access code and rate limits first: a refused request costs nothing.
  const refused = guardRequest(request, "report");
  if (refused) return refused;

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ ok: false, stage: "input", error: "The request body must be JSON." }, { status: 400 });
  }
  const result = await handleReportRequest(input);
  if (result.status !== 200) return Response.json(result.body, { status: result.status });

  return new Response(new Uint8Array(result.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // The filename is built from [a-z0-9-] only, so it needs no escaping.
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
