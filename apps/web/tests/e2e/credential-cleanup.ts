/**
 * Which credentials an e2e journey is allowed to delete.
 *
 * Why this file exists (nightly of 2026-09-15, run 34948237666): two Google
 * journeys — `help-guides.spec.ts` and `oauth-flow.spec.ts` — went red while
 * the product was fine. `credentials-reuse.spec.ts` had run first and left a
 * `google-oauth` credential behind; the `beforeAll` guard then refused to wipe
 * it, because nothing in the database told a journey-created credential apart
 * from an account a human connected by hand. The journeys were not independent
 * of their order.
 *
 * The fix is a marker, not a guess. Every credential an e2e journey creates is
 * named through `e2eCredentialName()`, which appends `[nodalai-e2e]`. Cleanup
 * deletes rows carrying that marker and NEVER touches a row without it: a
 * developer's real Google account keeps the same protection it had, and the
 * journeys stop tripping over each other.
 *
 * Kept out of `helpers.ts` on purpose — that module imports `@playwright/test`
 * at load time, and these functions are unit-tested under vitest.
 */

/**
 * The marker that makes an e2e-created credential recognisable. Deliberately
 * unlikely in a name a human would type, and matched literally — never a
 * heuristic on wording such as "(reuse test)".
 */
export const E2E_CREDENTIAL_MARKER = '[nodalai-e2e]';

/** Name to type in the credential wizard so cleanup can recognise the row. */
export function e2eCredentialName(label: string): string {
  return `${label} ${E2E_CREDENTIAL_MARKER}`;
}

/** True when the credential was created by an e2e journey. */
export function isE2ECredentialName(name: string): boolean {
  return name.includes(E2E_CREDENTIAL_MARKER);
}

export type CredentialForCleanup = { id: string; name: string };

export type CleanupPlan = {
  /** Rows to delete — always only e2e-marked rows, unless `allowWipe`. */
  deleteIds: string[];
  /**
   * Rows the journey refuses to delete on its own: credentials with no e2e
   * marker, i.e. accounts someone connected by hand. Empty when `allowWipe`.
   */
  blocked: CredentialForCleanup[];
};

/**
 * Decide what a `beforeAll` cleanup may delete.
 *
 * - marked rows (`[nodalai-e2e]`) are always deletable — they belong to a
 *   previous journey run, and no human ever typed that name;
 * - unmarked rows are blocked, and the caller fails loudly with the escape
 *   hatch, unless `allowWipe` (NODALAI_E2E_WIPE_CREDENTIALS=1) says otherwise.
 */
export function planCredentialCleanup(
  rows: readonly CredentialForCleanup[],
  opts: { allowWipe: boolean },
): CleanupPlan {
  if (opts.allowWipe) {
    return { deleteIds: rows.map((r) => r.id), blocked: [] };
  }
  const deleteIds: string[] = [];
  const blocked: CredentialForCleanup[] = [];
  for (const row of rows) {
    if (isE2ECredentialName(row.name)) deleteIds.push(row.id);
    else blocked.push(row);
  }
  return { deleteIds, blocked };
}

/** The message shown when a hand-connected account stands in the way. */
export function blockedCredentialsMessage(
  type: string,
  blocked: readonly CredentialForCleanup[],
): string {
  return (
    `Ce parcours part d'une base sans identifiant « ${type} », et cette pile en a ` +
    `${blocked.length} qu'aucun parcours e2e n'a créé (${blocked.map((r) => r.name).join(', ')}). ` +
    "Les supprimer effacerait un compte que quelqu'un a connecté à la main. Relancer avec " +
    'NODALAI_E2E_WIPE_CREDENTIALS=1 pour autoriser la suppression, ou viser une pile ' +
    'isolée (NODALAI_E2E_DB_URL).'
  );
}
