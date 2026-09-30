/**
 * POST /api/login — { "code": "…" } in; the access cookie out, if it's right.
 * Only matters when APP_ACCESS_CODE is set. Logic in lib/server/access.ts.
 */

import { handleLogin } from "@/lib/server/access";

export async function POST(request: Request) {
  return handleLogin(request);
}
