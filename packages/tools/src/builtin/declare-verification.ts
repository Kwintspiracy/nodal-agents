// Built-in: declare_verification
//
// POURQUOI CET OUTIL EXISTE. La vérification système de Nodal n'avait jamais
// tourné : sur la base de référence, `verification_runs` portait 0 ligne depuis
// l'origine, parce qu'un projet ne se vérifie que si son propriétaire a saisi
// des commandes — et qu'il n'a aucune raison de savoir lesquelles. Le
// propriétaire, le 08/09/2026 : « je sais pas quelle commande, je sais pas ce
// qu'il faut taper. Ce que je veux, c'est que ces tests soient décidés par
// l'agent. »
//
// Or l'agent SAIT : sur le job qui a livré une petite application web, il avait
// lancé de lui-même `node --check app.js` (sortie 0), puis un serveur et trois
// requêtes HTTP (200/200/200). Trois preuves d'exécution, produites
// spontanément, et aucune enregistrée — elles étaient passées par
// `run_command`, qui n'écrit pas dans la table des preuves.
//
// Cet outil ferme cet écart : celui qui construit déclare comment on vérifie ce
// qu'il vient de produire, et la finalisation l'exécute et l'enregistre.
//
// CE N'EST PAS UN POUVOIR NOUVEAU. Ces commandes, l'agent les a déjà exécutées
// pendant son travail, sous les règles d'autorisation que le propriétaire lui a
// fixées. D'où `defaultApproval: 'require_approval'`, identique à
// `run_command` : un agent qui doit demander pour exécuter doit demander pour
// déclarer ce qui sera exécuté. Laisser passer la déclaration contournerait la
// règle posée par le propriétaire, puisque la preuve tourne à la FIN, hors du
// flux d'approbation.

import { z } from 'zod';
import { codeProjects, jobDeliverableVerificationState, eq, and } from '@nodal-agents/db';
import {
  hashVerificationManifest,
  projectKey,
  normalizePath,
  VerifyCommandsSchema,
  VERIFY_COMMANDS_MAX,
  SHELL_POLICY_VERSION,
  ENV_ALLOWLIST_VERSION,
} from '@nodal-agents/shared';
import type { ToolDefinition } from '../types';

export const DeclareVerificationInputSchema = z.object({
  project_path: z
    .string()
    .min(1)
    .describe('Absolute path of the project this proof verifies — the folder you produced.'),
  commands: z
    .array(
      z.object({
        command: z.string().trim().min(1).max(2000),
        // Optionnel SANS `.default()` : un défaut zod rendrait le champ
        // obligatoire dans le type d'entrée, et chaque appelant devrait le
        // passer. Le défaut est posé à l'exécution, une seule fois.
        timeout_seconds: z.number().int().min(1).max(3600).optional(),
      }),
    )
    .min(1)
    .max(VERIFY_COMMANDS_MAX)
    .describe(
      'The commands that prove this project works, in order, stopped at the first failure. ' +
        'Use what you ALREADY ran to check your own work.',
    ),
});

export type DeclareVerificationInput = z.infer<typeof DeclareVerificationInputSchema>;

export type DeclareVerificationOutput =
  | { declared: true; project: string; commands: number }
  | { declared: false; reason: string };

export const declareVerificationTool: ToolDefinition<
  typeof DeclareVerificationInputSchema,
  DeclareVerificationOutput
> = {
  name: 'declare_verification',
  description:
    'Declare how to verify a project you just produced, so the system can run that proof and ' +
    'record it. Call it once, when the work is done, with the commands you ALREADY ran to check ' +
    'your own output — a syntax check, a build, a test suite, a request against a server you ' +
    'started. Each command must exit 0 when the project is healthy and non-zero when it is not; ' +
    'never declare a command that always succeeds, it would prove nothing. Do not declare ' +
    'anything for a project you did not produce or change. You can only declare for a project ' +
    'a tool of yours NAMED as its target: run your commands with cwd set to the project itself, ' +
    'not to the folder above it — a shell started one level up could have written anywhere, so ' +
    'it names nothing.',
  inputSchema: DeclareVerificationInputSchema,
  riskLevel: 'write',
  card: 'text',
  // Le même régime que `run_command` : la preuve s'exécutera plus tard, sans
  // repasser par une approbation. Sans cette ligne, déclarer serait un moyen
  // détourné d'exécuter sans demander.
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const path = normalizePath(input.project_path.trim());
    const key = projectKey(path);

    const [project] = await ctx.db
      .select({ id: codeProjects.id, projectPath: codeProjects.projectPath })
      .from(codeProjects)
      .where(and(eq(codeProjects.entityId, ctx.entityId), eq(codeProjects.projectKey, key)))
      .limit(1);
    if (!project) {
      // Échouer FORT, en nommant ce qui manque : déclarer une preuve pour un
      // projet inconnu la rendrait inexécutable, silencieusement.
      return {
        declared: false,
        reason:
          `No registered project at ${path}. Register it first (register_project), ` +
          'then declare its verification.',
      };
    }

    // CE job a-t-il produit quelque chose DANS ce projet ? La déclaration d'une
    // preuve n'est pas une opinion sur le travail d'autrui : sans cette garde,
    // un agent délégué pouvait déclarer — donc faire exécuter — une séquence
    // sur n'importe quel projet de l'espace, y compris en remplaçant celle que
    // le propriétaire avait approuvée (revue Codex, PR #49).
    //
    // La trace lue est `produced`, PAS `addressed` — et la distinction est
    // toute la garde. `addressed` dit ce qu'un outil a nommé, et il est écrit
    // AVANT l'exécution : un `file_edit` dont l'`old_string` est absent vise le
    // fichier, n'écrit rien, et laissait pourtant la trace. Un délégué pouvait
    // ainsi déclarer — donc faire exécuter — une séquence sur un projet qu'il
    // n'avait pas touché (revue Codex, PR #49, passe 2).
    //
    // `produced` n'est posé qu'APRÈS une écriture réussie, sur les seuls
    // livrables nommés. On lit cette ligne, on n'en fabrique pas une nouvelle.
    // UN REFUS PAR CAUSE, et chacun dit quoi faire.
    //
    // Le refus unique d'avant — « this job did not produce anything » — était
    // vrai et inutilisable : il ne distinguait pas « tu n'as jamais touché ce
    // projet » de « tu l'as bien écrit, mais depuis la racine du terrain, donc
    // rien ne dit que c'est LUI que tu visais ». Le second cas est le plus
    // fréquent, et sa réponse tient en une phrase : relancer la commande avec
    // `cwd` sur le projet. Sans elle, l'agent voit un mur (décision Quentin,
    // 09/09/2026, après la passe 3 de la revue Codex).
    const [trace] = await ctx.db
      .select({
        addressed: jobDeliverableVerificationState.addressed,
        produced: jobDeliverableVerificationState.produced,
      })
      .from(jobDeliverableVerificationState)
      .where(
        and(
          eq(jobDeliverableVerificationState.jobId, ctx.jobId),
          // L'identité d'une ligne d'état est (job, TYPE, clé) — le type fait
          // partie de la clé d'unicité, et l'omettre laissait `limit(1)`
          // choisir entre deux lignes que rien ne départage (revue Codex,
          // PR #49, passe 4). Cet outil ne déclare que pour des projets de
          // code : il lit la ligne de ce type, pas celle qui vient en premier.
          eq(jobDeliverableVerificationState.deliverableType, 'code_project'),
          eq(jobDeliverableVerificationState.canonicalKey, key),
        ),
      )
      .limit(1);
    if (!trace) {
      return {
        declared: false,
        reason:
          `This job never touched ${path}. Declare a verification only for what you built or ` +
          'changed in this run.',
      };
    }
    if (!trace.addressed) {
      // Le projet est dans le périmètre SALE — un shell peut écrire n'importe
      // où — mais aucun outil ne l'a nommé. C'est le cas du shell lancé à la
      // racine d'un dossier qui contient plusieurs projets : la commande a pu
      // écrire dans celui-ci, dans un autre, ou dans aucun, et rien dans la
      // trace ne le dit.
      return {
        declared: false,
        reason:
          `${path} is in this run's write scope, but no tool named it as its target — a shell ` +
          'run from the parent folder could have written anywhere in it. Run the command that ' +
          `proves this project with cwd set to ${path}, then declare its verification.`,
      };
    }
    if (!trace.produced) {
      // Ce refus disait « the tool that targeted it reported a failure ».
      // Depuis l'issue #102, c'est parfois faux, et c'est le prix assumé du
      // correctif : une cible DOSSIER — le `cwd` d'un shell — ne crédite plus
      // rien, puisque rien n'est lu sous un dossier. Un `run_command` qui a
      // parfaitement réussi arrive donc ici, et lui répondre qu'il a échoué
      // l'enverrait réparer un travail qui n'est pas cassé.
      //
      // La phrase dit maintenant le FAIT — aucune écriture observée —, ce que
      // le harnais lit et ne lit pas, et la sortie : nommer un fichier. Une
      // absence dite, pas un verdict sur le travail (invariant #4).
      //
      // En anglais ORDINAIRE : « constated » n'est pas un mot qu'un lecteur
      // anglophone emploie, et cette phrase est lue par un agent autant que par
      // une personne (revue C, passe 3). Le vocabulaire du code reste le nôtre ;
      // ce qui sort, non.
      return {
        declared: false,
        reason:
          `No write was observed in ${path} during this run. A write is observed by reading ` +
          'the file a tool NAMED, before and after it ran. Nobody reads what a shell command ' +
          'writes under its working directory, so running one there proves nothing. A coding ' +
          'harness sits in between: the files it reports are looked for on disk, so a run that ' +
          'reported none proves nothing either. Write what proves this project with a file ' +
          'tool, or name the file you wrote, then declare how it is verified. If a tool did ' +
          'report a failure, fix that first.',
      };
    }

    const commands = VerifyCommandsSchema.parse(
      input.commands.map((c) => ({
        command: c.command.trim(),
        timeoutSeconds: c.timeout_seconds ?? 120,
      })),
    );

    // Le manifeste couvre tout ce qui change le SENS de la preuve. On l'écrit
    // comme approuvé : c'est la déclaration de l'agent qui fait foi, et son
    // approbation a été demandée à l'appel de cet outil, pas après coup.
    const manifestHash = hashVerificationManifest({
      verifierConfig: commands,
      invariants: [],
      canonicalKey: key,
      cwd: project.projectPath,
      shellPolicyVersion: SHELL_POLICY_VERSION,
      envAllowlistVersion: ENV_ALLOWLIST_VERSION,
    });

    await ctx.db
      .update(codeProjects)
      .set({
        verifyCommands: commands,
        verifyApprovedManifestHash: manifestHash,
        verifyApprovedAt: new Date(),
        verifySource: 'agent',
        verifyDeclaredByJobId: ctx.jobId,
        updatedAt: new Date(),
      })
      .where(eq(codeProjects.id, project.id));

    return { declared: true, project: project.projectPath, commands: commands.length };
  },
};
