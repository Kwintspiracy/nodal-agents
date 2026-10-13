// autostart-view.ts — ce que la ligne « Start Nodal when this machine starts »
// montre (#451). Pur.
//
// L'état vient du SYSTÈME, par le CLI (`nodal-agents service status --json`,
// apps/cli/src/lib/autostart.ts) : la valeur Run de Windows, le LaunchAgent, l'unité
// systemd. Jamais un drapeau stocké, qui dirait « on » au-dessus d'une
// inscription retirée à la main. Une réponse illisible ne devient pas « off » :
// elle se dit (invariant #4).

import { z } from 'zod';

export const AutostartStatusSchema = z.discriminatedUnion('state', [
  /** `reason` : inscrit, mais coupé ailleurs (StartupApproved sous Windows). */
  z.object({ state: z.literal('off'), reason: z.string().optional() }),
  z.object({ state: z.literal('at_login'), lingerCommand: z.string().optional() }),
  z.object({ state: z.literal('at_boot') }),
  z.object({ state: z.literal('unsupported'), reason: z.string() }),
]);

export type AutostartStatus = z.infer<typeof AutostartStatusSchema>;

export type AutostartView = {
  /** `null` : le système n'a pas pu être interrogé ; `error` dit pourquoi. */
  status: AutostartStatus | null;
  error: string | null;
  isOwner: boolean;
};

/**
 * La réponse de `service … --json` : la DERNIÈRE ligne non vide de stdout (un
 * avertissement de node peut précéder), validée. `null` si elle ne se lit pas.
 */
export function parseServiceJson(stdout: string): AutostartStatus | null {
  const last = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .pop();
  if (last === undefined) return null;
  try {
    const parsed = AutostartStatusSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Le mot de la ligne dans la liste des réglages. */
export function autostartValue(view: AutostartView | null): string {
  if (view === null || view.status === null) return 'Could not be read';
  switch (view.status.state) {
    case 'off':
      return 'Off';
    case 'at_login':
      return 'Starts when you log in';
    case 'at_boot':
      return 'Starts at boot';
    case 'unsupported':
      return 'Not available on this machine';
  }
}

/**
 * Le toast qui suit le geste, déduit de l'état RELU dans le système et jamais du
 * seul « ok » de l'action : le CLI peut répondre sans erreur qu'il n'a rien
 * inscrit (`unsupported`, une install lancée par npx), ou que l'entrée est
 * toujours là. Succès seulement si l'état demandé est obtenu ; sinon, l'échec et
 * sa raison.
 */
export function autostartOutcome(
  requested: boolean,
  status: AutostartStatus,
): { ok: boolean; message: string } {
  const on = status.state === 'at_login' || status.state === 'at_boot';
  if (requested === on && status.state !== 'unsupported') {
    return {
      ok: true,
      message: on ? 'Nodal will start with this machine' : 'Nodal will not start with this machine',
    };
  }
  if (status.state === 'unsupported') return { ok: false, message: status.reason };
  if (status.state === 'off' && status.reason !== undefined) {
    return { ok: false, message: status.reason };
  }
  return {
    ok: false,
    message: requested
      ? 'Nodal is still off: this machine did not keep the startup entry.'
      : 'Nodal still starts with this machine: the startup entry could not be removed.',
  };
}
