// declare-verification.test.ts — celui qui construit dit comment on vérifie.
//
// Ce que ces tests protègent : après une déclaration, le projet est dans l'état
// que la finalisation appelle `ready` — donc la preuve TOURNERA. Tant que la
// configuration dépendait d'une saisie du propriétaire, elle n'a jamais tourné :
// 0 ligne dans `verification_runs` sur la base de référence, depuis l'origine.
//
// Règle de la maison : on assert les LIGNES réelles, pas des compteurs.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { codeProjects, jobDeliverableVerificationState, eq } from '@nodal-agents/db';
import {
  hashVerificationManifest,
  projectKey,
  SHELL_POLICY_VERSION,
  ENV_ALLOWLIST_VERSION,
} from '@nodal-agents/shared';
import { declareVerificationTool } from '../builtin/declare-verification';
import type { ToolContext } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const PROJET = 'C:/Users/kwint/Documents/Dev/recipes-app';

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

async function projet() {
  const [row] = await db
    .select({
      verifyCommands: codeProjects.verifyCommands,
      verifyApprovedManifestHash: codeProjects.verifyApprovedManifestHash,
      verifySource: codeProjects.verifySource,
      verifyDeclaredByJobId: codeProjects.verifyDeclaredByJobId,
      projectPath: codeProjects.projectPath,
    })
    .from(codeProjects)
    .where(eq(codeProjects.projectKey, projectKey(PROJET)));
  return row;
}

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

/**
 * La trace qu'un outil a écrit dans ce projet pendant ce job — posée en vrai
 * par l'intention de mutation (`addressed`), puis par le seam une fois
 * l'écriture RÉUSSIE (`produced`). Sans la seconde, la déclaration est
 * refusée : on ne déclare une preuve que pour ce qu'on a réellement produit.
 */
async function poserLaTrace(
  cle = projectKey(PROJET),
  { addressed = true, produced = true }: { addressed?: boolean; produced?: boolean } = {},
): Promise<void> {
  await db.insert(jobDeliverableVerificationState).values({
    jobId: seed.jobId,
    deliverableType: 'code_project',
    canonicalKey: cle,
    dirtyGeneration: 1,
    decisionStatus: 'dirty',
    addressed,
    produced,
  });
}

beforeEach(async () => {
  await db.delete(jobDeliverableVerificationState);
  await db.delete(codeProjects);
  await db.insert(codeProjects).values({
    entityId: seed.entityId,
    projectPath: PROJET,
    projectKey: projectKey(PROJET),
    displayName: 'Recipes',
    registeredAt: new Date(),
  });
});

describe('declare_verification', () => {
  it('écrit les commandes de l’agent, et les rend EXÉCUTABLES', async () => {
    await poserLaTrace();
    const out = await declareVerificationTool.execute(
      {
        project_path: PROJET,
        commands: [
          { command: 'node --check app.js', timeout_seconds: 60 },
          { command: 'curl -sf -o NUL http://127.0.0.1:8765/index.html', timeout_seconds: 30 },
        ],
      },
      ctx(),
    );
    expect(out).toEqual({ declared: true, project: PROJET, commands: 2 });

    const row = await projet();
    expect(row?.verifyCommands).toEqual([
      { command: 'node --check app.js', timeoutSeconds: 60 },
      { command: 'curl -sf -o NUL http://127.0.0.1:8765/index.html', timeoutSeconds: 30 },
    ]);
    expect(row?.verifySource).toBe('agent');
    expect(row?.verifyDeclaredByJobId).toBe(seed.jobId);

    // LE point du lot : le hash enregistré est CELUI que le vérificateur
    // recalculera. S'ils diffèrent, la configuration reste `pending_approval`
    // et la preuve ne tourne jamais — c'est exactement l'état dans lequel ce
    // produit est resté depuis l'origine.
    const attendu = hashVerificationManifest({
      verifierConfig: row!.verifyCommands!,
      invariants: [],
      canonicalKey: projectKey(PROJET),
      cwd: row!.projectPath,
      shellPolicyVersion: SHELL_POLICY_VERSION,
      envAllowlistVersion: ENV_ALLOWLIST_VERSION,
    });
    expect(row?.verifyApprovedManifestHash).toBe(attendu);
  });

  it('une déclaration plus tard REMPLACE la précédente, hash compris', async () => {
    await poserLaTrace();
    await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    const premier = (await projet())?.verifyApprovedManifestHash;

    await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'npm test' }] },
      ctx(),
    );
    const row = await projet();
    expect(row?.verifyCommands).toEqual([{ command: 'npm test', timeoutSeconds: 120 }]);
    // Le hash SUIT les commandes : sinon la nouvelle séquence tournerait sous
    // l'approbation de l'ancienne.
    expect(row?.verifyApprovedManifestHash).not.toBe(premier);
  });

  it('un projet non déclaré est refusé en le DISANT, sans rien écrire', async () => {
    const out = await declareVerificationTool.execute(
      { project_path: 'C:/Users/kwint/Documents/Dev/inconnu', commands: [{ command: 'true' }] },
      ctx(),
    );
    expect(out.declared).toBe(false);
    if (!out.declared) {
      expect(out.reason).toContain('No registered project');
      expect(out.reason).toContain('register_project');
    }
    // Le projet existant n'a pas bougé.
    expect((await projet())?.verifyCommands).toBeNull();
  });

  it('le délai par défaut est posé, pas laissé vide', async () => {
    await poserLaTrace();
    await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    expect((await projet())?.verifyCommands).toEqual([
      { command: 'node --check app.js', timeoutSeconds: 120 },
    ]);
  });

  it('un job qui n’a RIEN produit ici est refusé, en le disant', async () => {
    // Revue Codex PR #49 : sans cette garde, un agent délégué pouvait déclarer
    // — donc faire exécuter — une séquence sur n'importe quel projet de
    // l'espace, y compris en remplaçant celle du propriétaire.
    const out = await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    expect(out.declared).toBe(false);
    if (!out.declared) expect(out.reason).toContain('never touched');
    expect((await projet())?.verifyCommands).toBeNull();
  });

  it('une trace de PRÉCAUTION ne suffit pas, et le refus DIT quoi faire', async () => {
    // Un shell salit tout son périmètre par précaution. Cela ne fait pas de
    // chaque dossier voisin quelque chose qu'on a produit.
    //
    // Décision Quentin du 09/09/2026 : le remède est le `cwd` PRÉCIS, et le
    // refus doit l'enseigner. Un « this job did not produce anything » sec
    // était vrai et inutilisable — l'agent n'avait aucun moyen de savoir que
    // relancer sa commande depuis le projet suffisait.
    await poserLaTrace(projectKey(PROJET), { addressed: false, produced: false });
    const out = await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    expect(out.declared).toBe(false);
    if (!out.declared) {
      expect(out.reason).toContain('no tool named it as its target');
      expect(out.reason, 'le refus dit le geste exact').toContain(`cwd set to ${PROJET}`);
    }
    expect((await projet())?.verifyCommands).toBeNull();
  });

  it('les trois refus sont DISTINCTS — jamais fondus en un seul message', async () => {
    // Un message par cause : jamais touché / seulement dans le périmètre d'un
    // shell / visé mais rien écrit. Les trois appellent trois gestes
    // différents, et un message unique les rendait indistinguables.
    const jamais = await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    expect(jamais.declared).toBe(false);
    if (!jamais.declared) expect(jamais.reason).toContain('never touched');

    await db.delete(jobDeliverableVerificationState);
    await poserLaTrace(projectKey(PROJET), { addressed: false, produced: false });
    const precaution = await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    expect(precaution.declared).toBe(false);
    if (!precaution.declared) expect(precaution.reason).toContain('write scope');

    await db.delete(jobDeliverableVerificationState);
    await poserLaTrace(projectKey(PROJET), { addressed: true, produced: false });
    const echoue = await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    expect(echoue.declared).toBe(false);
    // Le troisième refus dit le FAIT — aucune écriture constatée — depuis
    // l'issue #102 : une cible dossier ne crédite plus rien, donc « l'outil a
    // rapporté un échec » serait faux pour un `run_command` qui a réussi.
    if (!echoue.declared) expect(echoue.reason).toContain('No write was constated');

    // Les trois messages diffèrent : c'est ce qui les rend utiles.
    const messages = [jamais, precaution, echoue].map((r) => (r.declared ? '' : r.reason));
    expect(new Set(messages).size).toBe(3);
  });

  it('avoir VISÉ ne suffit pas : il faut avoir RÉUSSI à écrire', async () => {
    // Revue Codex PR #49, passe 2. L'intention de mutation est posée AVANT
    // l'exécution : un `file_edit` dont l'`old_string` est absent VISE le
    // fichier, n'écrit rien, et laissait pourtant déclarer — donc remplacer la
    // séquence de preuve que le propriétaire avait approuvée.
    await poserLaTrace(projectKey(PROJET), { addressed: true, produced: false });
    const out = await declareVerificationTool.execute(
      { project_path: PROJET, commands: [{ command: 'node --check app.js' }] },
      ctx(),
    );
    expect(out.declared).toBe(false);
    if (!out.declared) expect(out.reason).toContain('No write was constated');
    expect((await projet())?.verifyCommands).toBeNull();
  });

  it('demande une approbation, comme la commande qu’elle fera tourner', () => {
    // La preuve s'exécute à la FIN, hors du flux d'approbation. Sans ce
    // réglage, déclarer serait un moyen détourné d'exécuter sans demander.
    expect(declareVerificationTool.defaultApproval).toBe('require_approval');
  });

  it('dit au modèle d’utiliser ce qu’il a DÉJÀ lancé', () => {
    // La description est ce que le modèle lit ; c'est elle qui décide s'il
    // déclare une vraie preuve ou une commande décorative.
    expect(declareVerificationTool.description).toContain('you ALREADY ran');
    expect(declareVerificationTool.description).toContain('exit 0');
    expect(declareVerificationTool.description).toContain('never declare a command that always');
  });
});
