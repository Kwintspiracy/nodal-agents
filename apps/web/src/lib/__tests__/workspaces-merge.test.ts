// workspaces-merge.test.ts — LA FUSION du registre et de la détection (#143).
//
// Ce que ces cas prouvent, et qui n'est prouvable nulle part ailleurs : un
// dossier détecté DÉJÀ au registre ne fait pas deux lignes. C'est le cas
// NORMAL — tout projet déclaré finit par recevoir des écritures — et le rater
// doublerait la liste entière sans qu'aucun écran ne s'en plaigne.
//
// Vérifié par MUTATION : en retirant le `continue` sur `registeredKeys` dans
// `mergeWorkspaces`, le premier cas passe de 1 à 2 lignes et rougit.

import { describe, it, expect } from 'vitest';
import {
  groupSessionsByProject,
  mergeWorkspaces,
  workspaceProof,
  workspacesSubtitle,
  type WorkspacePrefs,
  type WorkspaceSession,
} from '../workspaces.ts';
import type { ProjectListRow } from '../project-actions.ts';

const projet = (over: Partial<ProjectListRow> & { id: string; name: string }): ProjectListRow => ({
  path: 'D:/Terrain/projet',
  kind: 'code',
  registeredAt: new Date('2026-09-01T10:00:00Z'),
  hidden: false,
  lastProof: null,
  ...over,
});

const session = (over: Partial<WorkspaceSession> = {}): WorkspaceSession => ({
  projectPath: 'D:/Terrain/projet',
  projectName: 'projet',
  activityAt: '2026-09-10T09:00:00.000Z',
  ...over,
});

const prefs = (over: Partial<WorkspacePrefs> & { projectPath: string }): WorkspacePrefs => ({
  displayName: null,
  hidden: false,
  verifyStatus: 'not_configured',
  ...over,
});

describe('mergeWorkspaces @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un dossier détecté DÉJÀ au registre ne fait qu’UNE ligne, et garde SA date', () => {
    const view = mergeWorkspaces({
      projects: [projet({ id: 'p-1', name: 'Nodal', path: 'D:/Dev/nodal' })],
      sessions: [
        session({ projectPath: 'D:/Dev/nodal', activityAt: '2026-09-12T08:00:00.000Z' }),
        session({ projectPath: 'D:/Dev/nodal', activityAt: '2026-09-11T08:00:00.000Z' }),
      ],
      prefs: [],
    });

    expect(view.rows).toHaveLength(1);
    const ligne = view.rows[0]!;
    expect(ligne.kind).toBe('registered');
    expect(ligne.id).toBe('p-1');
    // La date affichée est celle de l'ENTRÉE AU REGISTRE, pas la dernière
    // écriture vue : c'est ce que la ligne promet.
    expect(ligne.createdAt?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(view.counts).toMatchObject({ total: 1, registered: 1, detected: 0 });
  });

  it('la fusion se fait par IDENTITÉ, pas par égalité de texte : deux casses, une ligne', () => {
    const view = mergeWorkspaces({
      projects: [projet({ id: 'p-1', name: 'App', path: 'C:/Dev/App' })],
      sessions: [session({ projectPath: 'c:/dev/app', projectName: 'app' })],
      prefs: [],
    });

    expect(view.rows).toHaveLength(1);
    // Le chemin AFFICHÉ reste celui du registre — c'est lui que le
    // propriétaire a déclaré.
    expect(view.rows[0]!.path).toBe('C:/Dev/App');
  });

  it('un dossier écrit et JAMAIS déclaré devient une ligne « detected », sans id ni page', () => {
    const view = mergeWorkspaces({
      projects: [],
      sessions: [
        session({
          projectPath: 'D:/APPS/scratch-tools',
          projectName: 'scratch-tools',
          activityAt: '2026-09-12T08:00:00.000Z',
        }),
        session({
          projectPath: 'D:/APPS/scratch-tools',
          projectName: 'scratch-tools',
          activityAt: '2026-09-08T08:00:00.000Z',
        }),
      ],
      prefs: [],
    });

    expect(view.rows).toHaveLength(1);
    const ligne = view.rows[0]!;
    expect(ligne.kind).toBe('detected');
    expect(ligne.id).toBeNull();
    expect(ligne.name).toBe('scratch-tools');
    // La PREMIÈRE écriture vue, pas la dernière : la ligne dit depuis quand ce
    // dossier existe pour Nodal.
    expect(ligne.createdAt?.toISOString()).toBe('2026-09-08T08:00:00.000Z');
    expect(ligne.produces).toBeNull();
    expect(view.counts).toMatchObject({ total: 1, registered: 0, detected: 1 });
  });

  it('MASQUER retire un dossier détecté de la liste ; il reste retrouvable derrière « Hidden »', () => {
    const entree = {
      projects: [],
      sessions: [session({ projectPath: 'D:/APPS/scratch', projectName: 'scratch' })],
    };

    const visible = mergeWorkspaces({ ...entree, prefs: [] });
    expect(visible.rows.map((r) => r.name)).toEqual(['scratch']);
    expect(visible.hiddenRows).toHaveLength(0);

    const masque = mergeWorkspaces({
      ...entree,
      prefs: [prefs({ projectPath: 'D:/APPS/scratch', hidden: true })],
    });
    expect(masque.rows).toHaveLength(0);
    expect(masque.hiddenRows.map((r) => r.name)).toEqual(['scratch']);
    expect(masque.hiddenRows[0]!.hidden).toBe(true);
    expect(masque.counts.total).toBe(0);
  });

  it('un projet de DOCUMENTS ne porte AUCUNE pastille : il n’a rien à prouver', () => {
    const view = mergeWorkspaces({
      projects: [
        projet({ id: 'p-1', name: 'Notes', path: 'D:/Docs/notes', kind: 'documents' }),
        projet({ id: 'p-2', name: 'Code', path: 'D:/Dev/code' }),
      ],
      sessions: [],
      prefs: [],
    });
    expect(view.rows.find((r) => r.id === 'p-1')!.proof).toBeNull();
    // Un projet de code, lui, dit ce qu'il en est — « Unverified » ici.
    expect(view.rows.find((r) => r.id === 'p-2')!.proof).toBe('unverified');
  });

  it('un projet du REGISTRE masqué SORT de la liste, et se retrouve derrière « Hidden »', () => {
    // #364. Il y restait avec une étiquette, ce qui défaisait le geste de la
    // barre latérale : « Remove from list » retirait le projet du menu, puis
    // renvoyait sur cette page, qui le montrait toujours.
    const view = mergeWorkspaces({
      projects: [
        projet({ id: 'p-1', name: 'Rangé', path: 'D:/Dev/range', hidden: true }),
        projet({ id: 'p-2', name: 'Gardé', path: 'D:/Dev/garde' }),
      ],
      sessions: [],
      prefs: [],
    });
    expect(view.rows.map((r) => r.name)).toEqual(['Gardé']);
    expect(view.hiddenRows.map((r) => r.name)).toEqual(['Rangé']);
    expect(view.hiddenRows[0]!.hidden).toBe(true);
    // Le sous-titre compte ce que la liste MONTRE, jamais ce que la base porte.
    expect(view.counts).toMatchObject({ total: 1, registered: 1, detected: 0 });
  });

  it('le SOUS-TITRE ne compte pas un dossier détecté que la page ne montre pas', () => {
    // Revue Reviewer C, passe 1 (mineur) : le filtre pouvait s'appliquer aux
    // lignes sans s'appliquer au compte, et « 0 projects · 0 registered, 1
    // detected » annoncerait une ligne introuvable à l'œil.
    const view = mergeWorkspaces({
      projects: [],
      sessions: [session({ projectPath: 'D:/APPS/scratch', projectName: 'scratch' })],
      prefs: [prefs({ projectPath: 'D:/APPS/scratch', hidden: true })],
    });
    expect(view.rows).toHaveLength(0);
    expect(view.counts).toMatchObject({ total: 0, registered: 0, detected: 0 });
    expect(workspacesSubtitle(view.counts)).toBe('0 projects · 0 registered, 0 detected');
  });

  it('les DEUX sortes de masqués sont dans la MÊME section, registre et détection', () => {
    const view = mergeWorkspaces({
      projects: [projet({ id: 'p-1', name: 'Rangé', path: 'D:/Dev/range', hidden: true })],
      sessions: [session({ projectPath: 'D:/APPS/scratch', projectName: 'scratch' })],
      prefs: [prefs({ projectPath: 'D:/APPS/scratch', hidden: true })],
    });
    expect(view.rows).toHaveLength(0);
    expect(view.hiddenRows.map((r) => r.kind).sort()).toEqual(['detected', 'registered']);
    expect(view.counts.total).toBe(0);
  });

  it('le nom choisi par le propriétaire l’emporte sur celui du dossier, même détecté', () => {
    const view = mergeWorkspaces({
      projects: [],
      sessions: [session({ projectPath: 'D:/APPS/x1', projectName: 'x1' })],
      prefs: [prefs({ projectPath: 'D:/APPS/x1', displayName: 'Client portal' })],
    });
    expect(view.rows[0]!.name).toBe('Client portal');
  });

  it('l’ordre est celui de la DATE, registre et détection mêlés', () => {
    const view = mergeWorkspaces({
      projects: [
        projet({
          id: 'p-vieux',
          name: 'vieux',
          path: 'D:/Dev/vieux',
          registeredAt: new Date('2026-09-01T00:00:00Z'),
        }),
      ],
      sessions: [
        session({
          projectPath: 'D:/APPS/neuf',
          projectName: 'neuf',
          activityAt: '2026-09-15T00:00:00.000Z',
        }),
      ],
      prefs: [],
    });
    expect(view.rows.map((r) => r.name)).toEqual(['neuf', 'vieux']);
  });
});

describe('workspaceProof @cap:verifier-un-livrable/moteur', () => {
  it('une approbation en attente passe AVANT le dernier verdict', () => {
    const vert = { verdict: 'pass' as const, at: new Date('2026-09-10T00:00:00Z') };
    expect(workspaceProof('pending_approval', vert)).toBe('approval_pending');
  });

  it('un rouge ne se dit pas « Unverified » : les deux états restent distincts', () => {
    expect(workspaceProof('approved', { verdict: 'fail', at: new Date() })).toBe('failed');
    expect(workspaceProof('approved', null)).toBe('unverified');
    expect(workspaceProof(null, null)).toBe('unverified');
  });

  it('un vert approuvé est la seule façon d’être « Verified »', () => {
    expect(workspaceProof('approved', { verdict: 'pass', at: new Date() })).toBe('verified');
  });
});

describe('groupSessionsByProject @cap:travailler-sur-des-fichiers/moteur', () => {
  it('une session sans dossier dérivable n’invente aucun projet', () => {
    const grouped = groupSessionsByProject([
      session({ projectPath: null, projectName: null }),
      session({ projectPath: '', projectName: null }),
    ]);
    expect(grouped.size).toBe(0);
  });

  it('la date retenue est la PLUS ANCIENNE écriture vue, pas la dernière', () => {
    const grouped = groupSessionsByProject([
      session({ projectPath: 'D:/a', activityAt: '2026-09-12T00:00:00.000Z' }),
      session({ projectPath: 'D:/a', activityAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    expect(grouped.get('d:/a')?.firstSeenAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('workspacesSubtitle @cap:travailler-sur-des-fichiers/ecran', () => {
  it('dit le total, les deux origines, et ce qui attend', () => {
    expect(workspacesSubtitle({ total: 5, registered: 3, detected: 2, waiting: 1 })).toBe(
      '5 projects · 3 registered, 2 detected · 1 waiting for you',
    );
  });

  it('ne dit RIEN quand rien n’attend, et ne pluralise pas un projet unique', () => {
    expect(workspacesSubtitle({ total: 1, registered: 1, detected: 0, waiting: 0 })).toBe(
      '1 project · 1 registered, 0 detected',
    );
  });
});
