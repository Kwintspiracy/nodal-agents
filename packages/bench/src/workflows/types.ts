// workflows/types.ts — un scénario, et la ligne qu'un essai laisse.
//
// Un scénario est FIGÉ une fois fusionné : même demande, même juge, nuit après
// nuit et version après version. C'est la seule façon de lire une courbe. Le
// jour où il faut le changer, on monte sa `version` : la ligne porte ce numéro,
// et le portail ouvre une nouvelle série au lieu de comparer deux choses
// différentes.

import type { BenchPrinterState } from '../printer/identity';
import type { TreeFacts } from './facts';

/**
 * Le genre d'un sujet de recherche calibré (subjects.ts, #776) : `research`, un
 * fait cherché par la racine seule ; `deep-research`, un sujet confié au
 * spécialiste.
 */
export const SUBJECT_KINDS = ['research', 'deep-research'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Un fait attendu d'un sujet, tel que le fichier l'écrit : sérialisable (une observation le garde tel quel). */
export interface SubjectFact {
  readonly says: string;
  readonly pattern: string;
  readonly flags: string;
}

/** Un sujet calibré, tel que `readResearchSubjects` le rend. */
export interface ResearchSubject {
  readonly id: string;
  readonly kind: SubjectKind;
  readonly request: string;
  readonly facts: readonly SubjectFact[];
  /** Les modèles sur lesquels le sujet est calibré. */
  readonly calibratedOn: readonly string[];
}

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
export const NEED_IDS = [
  'comfyui',
  'obsidian-vault',
  'bench-printer',
  'no-mail-sender',
  'no-real-printer',
] as const;
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

/**
 * Un agent actif de l'équipe qui peut LANCER un processus pendant l'essai : les
 * outils que le produit range `egress: 'process'` (`servedToolDefinitions`,
 * @nodal-agents/orchestration : run_command, run_skill_script, code_task,
 * declare_verification…) qu'un de ses jobs recevrait, ou son runtime de CLI
 * (Claude Code, Codex), dont les outils ne sont pas ceux de Nodal.
 */
export interface ProcessStarter {
  readonly agent: string;
  /** Les outils `process` qu'il tient ; vide quand c'est son runtime qui en lance. */
  readonly tools: readonly string[];
  /** Son runtime quand ce n'est pas celui de Nodal (`claude-code`, `codex`…), sinon null. */
  readonly runtime: string | null;
}

/** Un serveur MCP attribué à l'équipe ; `tools` null : ses outils ne sont pas connus. */
export interface TeamMcpServer {
  readonly slug: string;
  readonly tools: readonly string[] | null;
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
  /**
   * L'imprimante du banc (#794) : attachée à un agent actif de l'espace, et le
   * dossier où elle enregistre ce qu'elle reçoit, ou absente.
   */
  readonly benchPrinter: BenchPrinterState;
  /**
   * Les serveurs MCP de l'équipe, avec les noms de leurs outils (null : jamais
   * listés). Le besoin `bench-printer` n'accepte, hors l'imprimante du banc, que
   * des serveurs dont chaque outil est une lecture reconnue.
   */
  readonly teamMcpServers: readonly TeamMcpServer[];
  /**
   * Les agents actifs de l'équipe qui peuvent lancer un processus (besoin
   * `no-real-printer`) : vide, aucune commande ne peut partir pendant l'essai.
   */
  readonly processStarters: readonly ProcessStarter[];
  /**
   * Fin de l'essai (ms), quand le banc la connaît. Une demande reçue après n'est
   * pas de cet essai. Absent : l'instant du jugement.
   */
  readonly endedMs?: number;
  /** Les services locaux déclarés pour le banc, sondés au début de l'essai. */
  readonly services: Readonly<Record<string, ServiceProbe>>;
  /** Début de l'essai (ms). Un fichier plus ancien n'a pas été écrit par lui. */
  readonly startedMs: number;
  /**
   * Le sujet calibré de l'essai, posé par runTrial pour un scénario qui déclare
   * `subject` (et seulement pour lui : absent partout ailleurs).
   */
  readonly subject?: ResearchSubject;
}

/**
 * Les outils du produit par lesquels un scénario doit passer (décision 1 du
 * 17/10) : un livrable ÉCRIT l'est par l'un d'eux, un fichier LU l'est par l'un
 * d'eux. Si aucun n'est dans les outils de l'équipe, l'essai est SAUTÉ. La
 * règle est écrite une fois (judge-kit `productToolReasons`), pour tous.
 */
export interface ProductTools {
  /** Les noms nus des outils (`xlsx_read`), au moins un. */
  readonly tools: readonly string[];
  /**
   * Les livrables (sous `nodal-bench/`) que ces outils doivent ÉCRIRE : la
   * chaîne d'empreintes de `tool_call_writes`, dans l'ordre `seq`, va de
   * l'état préparé par le banc à l'état final du disque, et chaque écriture y
   * est celle d'un de ces outils, prouvée par ses octets écrits.
   */
  readonly writes: readonly string[];
  /**
   * Les fichiers (sous `nodal-bench/`) que ces outils doivent LIRE : une ligne
   * `tool_call_reads` d'un appel d'un de ces outils porte le chemin réel du
   * fichier posé ET l'empreinte de la fixture. Seulement pour un outil dont la
   * plateforme enregistre la lecture : un outil MCP n'en laisse aucune (#784).
   */
  readonly reads: readonly string[];
}

/** L'état d'un fichier : absent, lu (avec son empreinte sha-256), ou présent mais illisible. */
export type FileState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly sha256: string }
  | { readonly kind: 'unreadable' };

/**
 * Un fichier du scénario, tel que le banc le connaît hors de la base : ses
 * chemins réels possibles (un par dossier de travail, résolus comme la
 * plateforme les range, `cheminConstate`), le chemin réel où le banc POSE sa
 * fixture (le dossier partagé, `installFixture`), l'état où le banc l'a
 * préparé (la fixture posée, sinon absent) et son état sur le disque à la fin
 * de l'essai.
 */
export interface ProductFileState {
  readonly rel: string;
  readonly realPaths: readonly string[];
  /** Le chemin réel du fichier sous le dossier partagé, là où `installFixture` le pose. */
  readonly posedPath: string;
  readonly initial: FileState;
  readonly final: FileState;
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
  /**
   * Le chemin attendu, en clair (anglais : la carte du Studio) : qui fait quoi,
   * avec quels outils, et ce qui est seulement mesuré.
   */
  readonly path: string;
  /** Le livrable, en clair (anglais) : un fichier, une réponse, une demande en attente. */
  readonly deliverable: string;
  /** Les outils du produit que l'essai doit employer (voir `ProductTools`). Absent : aucun. */
  readonly productTools?: ProductTools;
  /**
   * La liste FERMÉE des outils que l'équipe peut employer pendant l'essai
   * (décision 1B, scenario-tools.ts) : un nom exact ou un préfixe suivi de
   * `*`. Tout autre outil d'un agent actif de l'espace est bloqué le temps de
   * l'essai, puis rendu tel qu'il était.
   */
  readonly tools: readonly string[];
  /**
   * Le sujet vient du fichier des sujets calibrés (subjects.ts), jamais du
   * scénario : `instruction` y porte `{subject}`. Sans sujet calibré de ce
   * genre, l'essai est SAUTÉ (#776).
   */
  readonly subject?: SubjectKind;
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
  /**
   * COMMENT le juge décide, en clair (anglais : rendu dans Bench Studio) : les
   * lignes de la base qu'il lit, le fichier qu'il ouvre et avec quoi, les
   * cellules et les valeurs attendues. Une phrase par contrôle, écrite à côté
   * du juge qu'elle décrit.
   */
  readonly judgedBy: readonly string[];
  /**
   * Les fichiers que le banc pose AVANT la demande (une fixture du dépôt,
   * packages/bench/fixtures, copiée dans le dossier du banc de l'espace
   * partagé). Déclarés, pas cachés dans du code : Bench Studio les montre.
   */
  readonly fixtures?: readonly FixtureInstall[];
  /**
   * Les chemins (sous `nodal-bench/`) que le banc efface avant l'essai : ce
   * qu'un essai précédent a laissé et qui ferait juger celui du jour sur le
   * travail de la veille.
   */
  readonly outputs?: readonly string[];
  /** Lit ce qu'il faut sur le disque, une fois l'essai fini. */
  observe(facts: TreeFacts, env: ScenarioEnv): Promise<O>;
  /** Pur : les raisons du rouge, vides pour un vert. */
  judge(facts: TreeFacts, observed: O): string[];
  /**
   * Le texte dont la ligne classe les liens (`TrialLine.links`) : un rapport
   * écrit sur le disque. Absent : la réponse finale du job de tête.
   */
  cites?(facts: TreeFacts, observed: O): string | null;
}

/** Une fixture posée avant l'essai : `from` relatif à packages/bench/fixtures, `to` sous `nodal-bench/`. */
export interface FixtureInstall {
  readonly from: string;
  readonly to: string;
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

/**
 * Le chemin d'un job de l'arbre : qui il est, qui l'a délégué, et les outils
 * qu'il a appelés, par leur nom et dans l'ordre (`tool_calls`).
 */
export interface PathJob {
  /** Les 8 premiers caractères du job. */
  readonly job: string;
  readonly agent: string | null;
  /** Le job qui l'a délégué (8 caractères) ; null pour le job de tête. */
  readonly parent: string | null;
  readonly tools: string[];
}

/**
 * Un lien cité, classé (#648, la partie mesurable) : `seen` quand il figure
 * dans la sortie d'un outil web de l'arbre qui ne l'avait pas reçu en entrée.
 * Qu'une page ait été LUE n'est pas dit ici (`SOURCES_READ`).
 */
export interface CitedLink {
  /** L'adresse normalisée (`normalizeUrl`). */
  readonly url: string;
  readonly seen: boolean;
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
  /**
   * La campagne qui a joué l'essai (le Nodal jetable du banc, campaign/), et
   * l'empreinte de la configuration appliquée à son instance
   * (`configFingerprint`) : deux lignes ne se comparent qu'à configuration
   * connue. null : un essai joué hors campagne. Absents des lignes d'avant les
   * campagnes.
   */
  readonly campaign?: string | null;
  readonly configFingerprint?: string | null;
  /**
   * L'empreinte de la liste d'outils du scénario (`scenarioToolsFingerprint`) :
   * la surface sur laquelle l'essai a joué. Absente des lignes d'avant 1B.
   */
  readonly scenarioToolsFingerprint?: string | null;
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
  /**
   * Le chemin de l'essai, job par job (voir `PathJob`). Absent des lignes
   * écrites avant le catalogue du 17/10 : « non enregistré », jamais « aucun
   * outil » (`cheminDe`, results.ts).
   */
  readonly path: PathJob[];
  /** Les agents des jobs délégués, dans l'ordre de leur création. Absent des anciennes lignes. */
  readonly delegatedTo: string[];
  /**
   * Les liens du texte cité (`Scenario.cites`, sinon la réponse), classés vu /
   * non vu. Absent des anciennes lignes.
   */
  readonly links: CitedLink[];
  /** Le sujet calibré joué (son identifiant) ; null pour un scénario sans sujet. */
  readonly subject: string | null;
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
