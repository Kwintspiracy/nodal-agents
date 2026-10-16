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

/**
 * Le métier qu'un scénario éprouve : les lignes de la matrice du portail. Liste
 * FERMÉE — une activité nouvelle s'ajoute ici, jamais à la volée dans un
 * scénario. Plusieurs activités n'ont pas encore de scénario (e-mail, Airtable,
 * Notion, Google Workspace, livraison, mémoire) : elles attendent un compte de
 * test, une décision du propriétaire ; le portail les montre vides.
 */
export const ACTIVITIES = [
  'question',
  'research',
  'deep-research',
  'code',
  'excel',
  'word',
  'powerpoint',
  'pdf',
  'image-comfyui',
  'html-page',
  'email',
  'airtable',
  'notion',
  'google-workspace',
  'delivery',
  'print',
  'orchestration',
  'memory',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/**
 * Les besoins qu'un scénario peut déclarer (vérifiés par needs.ts). Un nom hors
 * de cette liste ne compile pas.
 */
export const NEED_IDS = ['comfyui', 'obsidian-vault', 'printer', 'no-mail-sender'] as const;
export type Need = (typeof NEED_IDS)[number];

/**
 * Où un scénario fait envoyer quelque chose (revue Reviewer A de #756) :
 *   - `nothing` : rien ne doit partir ; un envoi pendant l'essai est rouge ;
 *   - `owner` : au propriétaire lui-même (son chat par défaut). Ne tourne
 *     qu'avec `--allow-owner-sends`, jamais dans un jeu, une activité, une
 *     matrice ni la nuit ; un envoi qui nomme un autre destinataire est rouge ;
 *   - `test-account:<nom>` : un compte de test déclaré. Aucun n'est branché
 *     aujourd'hui : un tel scénario est sauté.
 * recipients.test.ts refuse une demande d'envoi au propriétaire qui ne déclare pas `owner`.
 */
export type Sends = 'nothing' | 'owner' | `test-account:${string}`;

/** Un service local que le banc sait sonder, à l'adresse que ~/.nodalai/bench.json déclare. */
export interface ServiceProbe {
  readonly url: string;
  /** null : il répond. Sinon, ce qui a échoué. */
  readonly problem: string | null;
}

export interface ScenarioEnv {
  /** Les dossiers de travail de l'espace (le partagé d'abord). */
  readonly workspaceRoots: readonly string[];
  /**
   * Les outils que les agents actifs de l'espace peuvent appeler, sous le nom
   * que le produit leur donne (`readTeamTools`) : connecteurs adaptateurs et
   * serveurs MCP (`<serveur>__outil`) compris.
   */
  readonly teamTools: readonly string[];
  /**
   * Les serveurs MCP des agents actifs dont les outils ne sont pas connus (pas
   * de cache utilisable, `isUsableMcpToolCache`) : le runner s'y connectera et
   * pourra offrir n'importe quel outil. Le garde `no-mail-sender` refuse alors.
   */
  readonly unlistedMcpServers: readonly string[];
  /** Les services locaux déclarés pour le banc, sondés au début de l'essai. */
  readonly services: Readonly<Record<string, ServiceProbe>>;
  /** Début de l'essai (ms). Un fichier plus ancien n'a pas été écrit par lui. */
  readonly startedMs: number;
}

/**
 * Un contrôle que le scénario promettait et que le banc ne sait pas vérifier
 * aujourd'hui. Il n'est ni vert ni rouge : il est DIT, sur chaque ligne du
 * scénario, avec sa raison et le ticket qui le rétablira. Aucun vert ne
 * l'affirme.
 */
export interface UnverifiedCheck {
  readonly check: string;
  readonly state: 'not verified';
  /** Pourquoi, en une phrase (anglais : rendu au portail). */
  readonly reason: string;
  /** Le ticket qui le rétablira, `#N`. */
  readonly ticket: string;
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
  readonly activity: Activity;
  /** Où l'essai fait envoyer quelque chose (voir `Sends`). Déclaré par CHAQUE scénario. */
  readonly sends: Sends;
  /** Ce que l'essai demande à la machine. Un besoin absent : l'essai est SAUTÉ, avec sa raison. */
  readonly needs?: readonly Need[];
  /** La demande, telle que le propriétaire la taperait. */
  readonly instruction: string;
  readonly timeoutMs: number;
  /** Les contrôles que ce scénario ne vérifie pas encore (voir `UnverifiedCheck`). */
  readonly unverified?: readonly UnverifiedCheck[];
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

/**
 * Un modèle tel qu'un job de l'essai l'a utilisé : ce qui était DEMANDÉ et ce
 * qui a RÉPONDU (un maillon de secours peut répondre à la place), lu dans
 * `llm_calls` (API) et `cli_runs` (Claude Code, Codex). Une ligne par job et
 * par combinaison demandé / effectif / fournisseur / effort / secours.
 */
export interface ModelUse {
  /** Les 8 premiers caractères du job. */
  readonly job: string;
  readonly agent: string | null;
  readonly via: 'api' | 'cli';
  readonly requested: string | null;
  readonly effective: string;
  readonly provider: string | null;
  readonly reasoningEffort: string | null;
  /** Servi par un maillon de secours. null : la ligne ne le dit pas (CLI, ancienne capture). */
  readonly failover: boolean | null;
  readonly calls: number;
  /** Entrée cache compris (même sémantique que `TrialLine.inputTokens`). */
  readonly inputTokens: number | null;
  /** Lectures de cache, comprises dans `inputTokens`. */
  readonly cachedTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

/** Un fichier que l'essai a laissé dans le dossier du banc d'un dossier de travail. */
export interface Deliverable {
  /** Relatif au dossier de travail, toujours sous `nodal-bench/`, en barres obliques. */
  readonly path: string;
  readonly bytes: number;
}

/** Une ligne de apps/qa/data/workflows.ndjson : un essai, ajouté, jamais réécrit. */
export interface TrialLine {
  readonly scenario: string;
  readonly scenarioVersion: number;
  /** Le titre et le critère du vert, portés par chaque ligne : le portail lit une série sans le code TS. */
  readonly title: string;
  readonly green: string;
  readonly set: ScenarioSet;
  /**
   * Absents des lignes écrites avant la v2 du banc : le portail range une
   * telle ligne sous l'activité du scénario dans le catalogue.
   */
  readonly activity: Activity;
  readonly needs: Need[];
  /** La destination déclarée par le scénario (absente des lignes d'avant la passe 2 de revue). */
  readonly sends: Sends;
  /**
   * Le modèle que la matrice (`--models`) a imposé à l'essai ; null : les
   * agents tournaient sur leurs propres modèles.
   */
  readonly modelUnderTest: string | null;
  /** Le modèle configuré de l'agent racine au début de l'essai (`agents.model`). */
  readonly rootModel: string | null;
  readonly nodalVersion: string;
  /** Le commit extrait dans le dossier de la stack, en 12 caractères. */
  readonly stackCommit: string | null;
  readonly trigger: 'manual' | 'scheduled';
  readonly startedAt: string;
  readonly verdict: TrialVerdict;
  readonly reasons: string[];
  /** Les contrôles du scénario qui ne sont pas vérifiés : ni dans le verdict, ni tus. */
  readonly unverified: UnverifiedCheck[];
  /** Création du job de tête → dernière mise à jour de l'arbre. */
  readonly durationMs: number | null;
  /** Création du job de tête → premier appel de modèle ou tour de CLI enregistré (sa fin). */
  readonly firstModelReplyMs: number | null;
  readonly jobs: number;
  readonly agents: string[];
  readonly models: string[];
  readonly toolCalls: number;
  /** Appels de modèle en API (`llm_calls`). */
  readonly llmCalls: number;
  /** Tours d'une CLI de code, Claude Code ou Codex (`cli_runs`). */
  readonly cliRuns: number;
  /** Entrée cache compris, API et CLI confondues. null = un appel ne l'a pas rapportée. */
  readonly inputTokens: number | null;
  /** Lectures de cache, comprises dans `inputTokens`. null = un appel ne l'a pas rapportée. */
  readonly cachedTokens: number | null;
  /** Écritures de cache, comprises dans `inputTokens`. null = un appel ne l'a pas rapportée. */
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  /**
   * Dollars facturés à l'appel (API, CLI payée par clé). null = un appel facturé
   * n'a pas rapporté son prix, ou l'arbre n'a tourné que sous abonnement.
   */
  readonly costUsd: number | null;
  /** Approbations et questions levées par l'essai (toutes, résolues ou non). */
  readonly approvals: number;
  readonly rootJobId: string | null;
  /** Le banc a dû annuler l'arbre (approbation, dépassement, erreur). */
  readonly cancelled: boolean;
  /** Les modèles de chaque job, demandés et effectifs. */
  readonly modelUse: ModelUse[];
  /** Ce que l'essai a laissé sous `nodal-bench/`, écrit pendant l'essai. */
  readonly deliverables: Deliverable[];
  /** La réponse finale du job de tête, tronquée (`ANSWER_MAX` caractères), dossier personnel masqué. */
  readonly answer: string | null;
}
