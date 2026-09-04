// verification-display.ts — les helpers PURS de la configuration de preuve
// d'un projet (plan « Vérifier & Corriger », T21 / D9).
//
// Module frère d'actions.ts pour la même raison que code-projects.ts : un
// fichier 'use server' n'exporte que des fonctions async, et ces règles sont
// synchrones et testables seules.
//
// LE HASH SE CALCULE AU SERVEUR, jamais au navigateur. packages/shared est
// bundlé côté client, donc l'import compilerait — mais un hash calculé par le
// client laisserait approuver un manifeste que le serveur n'a pas relu. Le
// hash que le client renvoie est un JETON de concurrence optimiste : le
// serveur relit la ligne, recalcule, compare, et écrit SA valeur.

import {
  hashVerificationManifest,
  projectKey,
  SHELL_POLICY_VERSION,
  ENV_ALLOWLIST_VERSION,
  type VerifyCommand,
  type VerificationManifest,
} from '@nodal-agents/shared';

export type VerifyStatus = 'not_configured' | 'pending_approval' | 'approved';

/**
 * Le manifeste d'un projet de code, tel que le vérificateur du runner le
 * recalcule avant chaque preuve : mêmes six champs, même ordre de commandes,
 * `invariants: []` tant que l'owner n'en a pas déclaré. Une divergence entre
 * ce manifeste et celui du runner rendrait `pending_approval` à chaque preuve —
 * fail-closed, jamais un faux vert.
 */
export function codeProjectManifest(input: {
  projectPath: string;
  verifyCommands: readonly VerifyCommand[];
}): VerificationManifest {
  return {
    verifierConfig: input.verifyCommands,
    invariants: [],
    canonicalKey: projectKey(input.projectPath),
    cwd: input.projectPath,
    shellPolicyVersion: SHELL_POLICY_VERSION,
    envAllowlistVersion: ENV_ALLOWLIST_VERSION,
  };
}

/** Le hash courant d'un projet — `null` quand il n'a pas de commandes. */
export function currentManifestHash(input: {
  projectPath: string;
  verifyCommands: readonly VerifyCommand[] | null;
}): string | null {
  if (!input.verifyCommands || input.verifyCommands.length === 0) return null;
  return hashVerificationManifest(
    codeProjectManifest({ projectPath: input.projectPath, verifyCommands: input.verifyCommands }),
  );
}

/**
 * Le statut de configuration, dérivé des colonnes : pas de commandes ⇒
 * `not_configured` ; des commandes dont le hash approuvé n'est pas celui du
 * manifeste courant (absent, ou périmé par une modification) ⇒
 * `pending_approval` ; égal ⇒ `approved`.
 */
export function deriveVerifyStatus(input: {
  projectPath: string;
  verifyCommands: readonly VerifyCommand[] | null;
  verifyApprovedManifestHash: string | null;
}): VerifyStatus {
  const current = currentManifestHash(input);
  if (current === null) return 'not_configured';
  return input.verifyApprovedManifestHash === current ? 'approved' : 'pending_approval';
}
