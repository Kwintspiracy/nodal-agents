// workflows/types.ts — un scénario, et la ligne qu'un essai laisse.
//
// Un scénario est FIGÉ une fois fusionné : même demande, même juge, nuit après
// nuit et version après version. C'est la seule façon de lire une courbe. Le
// jour où il faut le changer, on monte sa `version` : la ligne porte ce numéro,
// et le portail ouvre une nouvelle série au lieu de comparer deux choses
// différentes.

import type { TreeFacts } from './facts';

/**
 * `nightly` : le jeu sans surveillance, lancé chaque nuit.
 * `on-demand` : lancé seulement quand on le nomme (`--only`) ou par le jeu
 * `release` — un GPU dix minutes, ou un envoi hors de la machine que le
 * propriétaire n'a pas encore accepté la nuit.
 */
export type ScenarioSet = 'nightly' | 'on-demand';

export interface ScenarioEnv {
  /** Les dossiers de travail de l'espace (le partagé d'abord). */
  readonly workspaceRoots: readonly string[];
  /** Les outils que les connecteurs actifs de l'espace offrent, par leur nom nu. */
  readonly connectorTools: readonly string[];
  /** Début de l'essai (ms). Un fichier plus ancien n'a pas été écrit par lui. */
  readonly startedMs: number;
}

export interface Scenario<O> {
  readonly id: string;
  /** Monte quand la demande ou le juge change : une nouvelle série commence. */
  readonly version: number;
  /** Ce que l'essai fait, en une ligne lisible par quelqu'un qui ne code pas (anglais : rendu au portail). */
  readonly title: string;
  /** Ce que « vert » veut dire, en clair (anglais : rendu au portail). */
  readonly green: string;
  readonly set: ScenarioSet;
  /** La demande, telle que le propriétaire la taperait. */
  readonly instruction: string;
  readonly timeoutMs: number;
  /** Ce qui manque pour que l'essai ait un sens. Non vide : ROUGE, sans lancer de job. */
  requires?(env: ScenarioEnv): string[];
  /** Remet à zéro ce qu'un essai précédent du banc a laissé (ses propres fichiers seulement). */
  prepare?(env: ScenarioEnv): void;
  /** Lit ce qu'il faut sur le disque, une fois l'essai fini. */
  observe(facts: TreeFacts, env: ScenarioEnv): Promise<O>;
  /** Pur : les raisons du rouge, vides pour un vert. */
  judge(facts: TreeFacts, observed: O): string[];
}

export type AnyScenario = Scenario<unknown>;

export function defineScenario<O>(s: Scenario<O>): AnyScenario {
  return s as unknown as AnyScenario;
}

export type TrialVerdict = 'green' | 'red' | 'skipped' | 'error';

/** Une ligne de apps/qa/data/workflows.ndjson : un essai, ajouté, jamais réécrit. */
export interface TrialLine {
  readonly scenario: string;
  readonly scenarioVersion: number;
  /** Le titre et le critère du vert, portés par chaque ligne : le portail lit une série sans le code TS. */
  readonly title: string;
  readonly green: string;
  readonly set: ScenarioSet;
  readonly nodalVersion: string;
  readonly stackCommit: string | null;
  readonly trigger: 'manual' | 'scheduled';
  readonly startedAt: string;
  readonly verdict: TrialVerdict;
  readonly reasons: string[];
  /** Création du job de tête → dernière mise à jour de l'arbre. */
  readonly durationMs: number | null;
  /** Création du job de tête → premier appel de modèle enregistré (sa fin). */
  readonly firstModelReplyMs: number | null;
  readonly jobs: number;
  readonly agents: string[];
  readonly models: string[];
  readonly toolCalls: number;
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** Approbations et questions levées par l'essai (toutes, résolues ou non). */
  readonly approvals: number;
  readonly rootJobId: string | null;
  /** Le banc a dû annuler l'arbre (approbation, dépassement, erreur). */
  readonly cancelled: boolean;
}
