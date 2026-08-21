// routes/code-task-doctor.ts — POST /api/code-task/doctor
//
// Probes a coding CLI's health on the RUNNER machine (binary present →
// version → logged in) for the capability UI's "Tester" button (étape B of
// the subscription-runtimes plan). The probe MUST run runner-side: the Next
// process may live elsewhere (LAN mode), and PATH is a per-process fact.
//
// Auth: behind requireRunnerAuth (registered in server.ts). The probe reads
// machine state only — it never touches credentials (D0 red line) and spends
// zero subscription usage (`--version` + `codex login status` are free).

import type { Context } from 'hono';
import { z } from 'zod';
import { runCliDoctor } from '@nodal-agents/tools';

const DoctorRequestSchema = z.object({
  provider: z.enum(['claude', 'codex']),
});

export async function codeTaskDoctorRoute(c: Context): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = DoctorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const report = await runCliDoctor(parsed.data.provider);
  return c.json(report, 200);
}
