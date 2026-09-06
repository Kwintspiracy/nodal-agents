// verification/office-file.ts — le vérificateur du livrable « fichier
// bureautique » (classeur, document, présentation).
//
// POURQUOI CE FICHIER EXISTE (v7-A). Le type de livrable était écrit en dur à
// `'code_project'` dans le helper d'intention : un `.xlsx` écrit dans un dépôt
// salissait le DÉPÔT. La finalisation relançait alors `pnpm test` pour prouver
// un classeur — et le classeur, lui, n'était vérifié par rien. Les outils
// Office déclarent désormais ce qu'ils produisent ; il faut donc un
// vérificateur pour ce type, sinon la finalisation lève
// `DELIVERABLE_TYPE_UNSUPPORTED` sur un job parfaitement normal.
//
// CE QU'IL FAIT EN v7-A, ET RIEN DE PLUS : il donne au fichier son IDENTITÉ
// (`projectKey`, la même règle de casse que partout) et rend
// `not_configured` — « ce livrable n'est pas encore vérifiable ». C'est un
// état honnête, pas un vert par défaut : la finalisation le compte comme non
// vérifié et l'écran le dit.
//
// CE QUE v7-B AJOUTERA. Les vérifications d'un document ne s'exécutent pas :
// ouvrir le classeur, constater qu'il s'ouvre, que les feuilles demandées
// existent, qu'aucune cellule ne porte `#REF!`. Aucune de ces preuves ne fait
// tourner de code du dépôt — elles sont donc « sans pouvoir », et n'auront
// jamais à être approuvées, contrairement à une séquence de commandes.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import type {
  DeliverableVerifier,
  LoadedConfig,
  OnCommandDone,
  ProofResult,
  ReadyConfig,
  VerifierTarget,
} from './types.ts';

/** Levé si une preuve est demandée alors qu'aucune n'est configurable (v7-A). */
export const OFFICE_FILE_PROOF_UNAVAILABLE = 'OFFICE_FILE_PROOF_UNAVAILABLE';

const officeFileDeliverableType = 'office_file' as const;

export const officeFileVerifier: DeliverableVerifier = {
  deliverableType: officeFileDeliverableType,

  /**
   * L'identité d'un fichier est son chemin, replié en casse sur Windows
   * seulement — `projectKey`, la seule copie de cette règle dans le dépôt.
   * Deux écritures du même classeur doivent rendre la même clé, sinon un job
   * porterait deux états pour un seul livrable.
   */
  canonicalize(raw: string): string {
    return projectKey(raw);
  },

  /**
   * Rien à charger, rien à approuver : v7-A ne sait pas encore prouver un
   * document. `not_configured` est LA façon de le dire — la finalisation la
   * traite déjà comme « non vérifiable », ni verte ni rouge.
   *
   * Aucune lecture en base, donc aucun verrou : le paramètre `tx` fait partie
   * du contrat et sera utilisé en v7-B.
   */
  async loadConfig(_tx: AnyDrizzleDb, _target: VerifierTarget): Promise<LoadedConfig> {
    return { kind: 'not_configured' };
  },

  /**
   * Injoignable tant que `loadConfig` ne rend jamais `ready` : la primitive ne
   * lance une preuve que sur une configuration prête. Lève plutôt que de
   * rendre un vert vide — un verdict inventé est pire que l'absence de
   * verdict (invariant #4).
   */
  async runProof(_config: ReadyConfig, _onCommandDone: OnCommandDone): Promise<ProofResult> {
    throw new Error(`${OFFICE_FILE_PROOF_UNAVAILABLE}: ${officeFileDeliverableType}`);
  },
};
