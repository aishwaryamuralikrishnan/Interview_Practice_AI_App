/**
 * GET /api/session — whether an access code is required, and whether this
 * browser has already entered it. Never reveals the code.
 */

import { sessionStatus } from "@/lib/server/access";

export function GET(request: Request) {
  return sessionStatus(request);
}
