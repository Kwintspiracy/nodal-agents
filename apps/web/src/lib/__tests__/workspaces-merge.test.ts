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
  agentId: 'agent-1',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  registeredFrom: 'spaces',
  registeredAt: new Date('2026-09-01T10:00:00Z'),
  hidden: false,
  jobsCount: 0,
  conversationsCount: 0,
  lastActivityAt: null,
  lastProof: null,
  ...over,
});

const session = (over: Partial<WorkspaceSession> = {}): WorkspaceSession => ({
  projectPath: 'D:/Terrain/projet',
  projectName: 'projet',
  agentName: 'Alfred',
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
  it('un dossier détecté DÉJÀ au registre ne fait qu’UNE ligne, enrichie de ses sessions', () => {
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
    expect(ligne.sessions).toBe(2);
    expect(ligne.lastActivityAt?.toISOString()).toBe('2026-09-12T08:00:00.000Z');
    expect(view.counts).toMatchObject({ total: 1, registered: 1, detected: 0 });
  });

  it('la fusion se fait par IDENTITÉ, pas par égalité de texte : deux casses, une ligne', () => {
    const view = mergeWorkspaces({
      projects: [projet({ id: 'p-1', name: 'App', path: 'C:/Dev/App' })],
      sessions: [session({ projectPath: 'c:/dev/app', projectName: 'app' })],
      prefs: [],
    });

    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.sessions).toBe(1);
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
          agentName: 'Alfred',
        }),
      ],
      prefs: [],
    });

    expect(view.rows).toHaveLength(1);
    const ligne = view.rows[0]!;
    expect(ligne.kind).toBe('detected');
    expect(ligne.id).toBeNull();
    expect(ligne.name).toBe('scratch-tools');
    expect(ligne.agentName).toBe('Alfred');
    // Rien n'est COMPTÉ qu'on n'a pas compté : un dossier hors registre ne
    // porte pas de conversations, et « 0 » laisserait croire à un comptage.
    expect(ligne.conversations).toBeNull();
    expect(ligne.produces).toBeNull();
    expect(view.counts).toMatchObject({ total: 1, registered: 0, detected: 1 });
  });

  it('MASQUER retire un dossier détecté de la liste ; il reste retrouvable derrière « Show »', () => {
    const entree = {
      projects: [],
      sessions: [session({ projectPath: 'D:/APPS/scratch', projectName: 'scratch' })],
    };

    const visible = mergeWorkspaces({ ...entree, prefs: [] });
    expect(visible.rows.map((r) => r.name)).toEqual(['scratch']);
    expect(visible.hiddenDetected).toHaveLength(0);

    const masque = mergeWorkspaces({
      ...entree,
      prefs: [prefs({ projectPath: 'D:/APPS/scratch', hidden: true })],
    });
    expect(masque.rows).toHaveLength(0);
    expect(masque.hiddenDetected.map((r) => r.name)).toEqual(['scratch']);
    expect(masque.hiddenDetected[0]!.hidden).toBe(true);
    expect(masque.counts.total).toBe(0);
  });

  it('un projet du REGISTRE masqué reste listé, avec son drapeau', () => {
    const view = mergeWorkspaces({
      projects: [projet({ id: 'p-1', name: 'Rangé', path: 'D:/Dev/range', hidden: true })],
      sessions: [],
      prefs: [],
    });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.hidden).toBe(true);
  });

  it('le nom choisi par le propriétaire l’emporte sur celui du dossier, même détecté', () => {
    const view = mergeWorkspaces({
      projects: [],
      sessions: [session({ projectPath: 'D:/APPS/x1', projectName: 'x1' })],
      prefs: [prefs({ projectPath: 'D:/APPS/x1', displayName: 'Client portal' })],
    });
    expect(view.rows[0]!.name).toBe('Client portal');
  });

  it('l’ordre est celui de la dernière activité, registre et détection mêlés', () => {
    const view = mergeWorkspaces({
      projects: [
        projet({
          id: 'p-vieux',
          name: 'vieux',
          path: 'D:/Dev/vieux',
          lastActivityAt: new Date('2026-09-01T00:00:00Z'),
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

  it('l’agent retenu est celui de la session la plus RÉCENTE', () => {
    const grouped = groupSessionsByProject([
      session({ projectPath: 'D:/a', agentName: 'Dernier', activityAt: '2026-09-12T00:00:00Z' }),
      session({ projectPath: 'D:/a', agentName: 'Premier', activityAt: '2026-09-01T00:00:00Z' }),
    ]);
    expect(grouped.get('d:/a')?.agentName).toBe('Dernier');
    expect(grouped.get('d:/a')?.sessions).toBe(2);
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
