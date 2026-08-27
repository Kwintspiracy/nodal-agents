'use client';

// CodeProcessesTable — la page /code, organisée PAR PROJET (décision Quentin
// 25/08)  : « ce qui est intéressant, c'est de suivre le développement d'un
// produit » — pas une liste plate de sessions où trois items consécutifs
// concernent le même repo sans que rien ne le dise.
//
// Trois niveaux :
//   1. Les PROJETS (dérivés : racine git / workspace des fichiers touchés) —
//      une carte par projet : sessions, agents, dernière activité, coût.
//      Les sessions inclassables vivent dans le tiroir « Other sessions ».
//   2. Un projet ouvert = sa CHRONOLOGIE de sessions (la table existante,
//      filtrée) — les agents deviennent les acteurs de l'histoire du projet.
//   3. Le détail d'une session (/code/[id]) est inchangé.
//
// La page ne FILTRE plus rien (décision Quentin 26/08, migration 0086) : elle
// montre les dossiers où les agents ont écrit, et donne au propriétaire les
// deux gestes qu'aucun indice du système ne peut poser à sa place.
//
//   RENOMMER — le nom du dossier n'est pas toujours le nom du projet.
//   MASQUER  — ce qu'on ne veut plus voir. Le dossier réel n'est JAMAIS
//              touché, et le projet quitte AUSSI le contexte injecté aux
//              agents (apps/runner/src/job/code-projects.ts). Réversible d'un
//              clic depuis la section « Hidden ».
//
// Poll : listCodingProcessesAction toutes les 5s tant qu'une session est en
// 'coding' — le regroupement est recalculé à chaque rafraîchissement.

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  listCodingProcessesAction,
  getCodingProcessDetailAction,
  setCodeProjectHiddenAction,
  renameCodeProjectAction,
  type CodeProjectPrefs,
  type CodingProcessRow,
  type CodingProcessDetail as CodingProcessDetailData,
} from '@/lib/actions.ts';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import RowActionButton from '@/components/ui/RowActionButton';
import TextButton from '@/components/ui/TextButton';
import Select from '@/components/ui/Select';
import TextInput from '@/components/ui/TextInput';
import { projectKey } from '@/lib/project-key.ts';
import { relativeTime } from '@/lib/format-time';
import CodeProcessDetail from './[id]/CodeProcessDetail.tsx';

const POLL_INTERVAL = 5000;

/** Clé du tiroir des sessions sans projet dérivable. Ni renommable, ni masquable. */
const OTHER_KEY = '__other__';

const STAGE_LABEL: Record<string, string> = {
  coding: 'Coding',
  delegated: 'Delegated',
  review: 'Review',
  done: 'Done',
  done_approved: 'Done · Approved',
  failed: 'Failed',
  chat: 'Chat',
  awaiting_approval: 'Blocked',
};

function stageVariant(stage: string): StatusVariant {
  if (stage === 'coding' || stage === 'delegated' || stage === 'review') return 'run';
  if (stage === 'done' || stage === 'done_approved') return 'done';
  if (stage === 'failed' || stage === 'awaiting_approval') return 'warn';
  return 'idle';
}

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

type Project = {
  key: string;
  name: string;
  path: string | null;
  sessions: CodingProcessRow[];
  agentNames: string[];
  totalCostUsd: number;
  lastActivityAt: string | null;
  /** Étape de la session la plus récente — l'état « vivant » du projet. */
  latestStage: string;
};

function groupProjects(rows: CodingProcessRow[], names: Map<string, string>): Project[] {
  const byKey = new Map<string, Project>();
  // rows arrivent triées par activité décroissante — la première session d'un
  // groupe est donc la plus récente, et l'ordre des projets suit.
  for (const row of rows) {
    const key = row.projectPath ? projectKey(row.projectPath) : OTHER_KEY;
    const existing = byKey.get(key);
    if (existing) {
      existing.sessions.push(row);
      existing.totalCostUsd += row.costUsd;
      if (row.agentName && !existing.agentNames.includes(row.agentName)) {
        existing.agentNames.push(row.agentName);
      }
    } else {
      byKey.set(key, {
        key,
        // Le nom choisi par le propriétaire l'emporte sur celui du dossier.
        name: names.get(key) ?? row.projectName ?? 'Other sessions',
        path: row.projectPath,
        sessions: [row],
        agentNames: row.agentName ? [row.agentName] : [],
        totalCostUsd: row.costUsd,
        lastActivityAt: row.activityAt,
        latestStage: row.stage,
      });
    }
  }
  return Array.from(byKey.values());
}

export default function CodeProcessesTable({
  initialRows,
  initialPrefs,
  workspaceCount,
  hiddenWorkspaceCount,
  error,
}: {
  initialRows: CodingProcessRow[];
  /** Les projets renommés et/ou masqués. Vide sur un espace qui n'a rien rangé. */
  initialPrefs: CodeProjectPrefs[];
  /**
   * Combien de dossiers sont attaches aux agents de cet espace. A zero, la
   * liste est vide PAR CONSTRUCTION et non faute d'activite : les agents
   * n'ont nulle part ou ecrire. L'etat vide doit alors nommer le geste
   * manquant plutot que d'accuser les agents de n'avoir rien fait.
   * `null` = le comptage a echoue, et on ne pretend rien.
   */
  workspaceCount: number | null;
  /** Dossiers masqués de l'onglet (0087) — pour ne pas confondre « rien » et « tout masqué ». */
  hiddenWorkspaceCount: number;
  error?: string;
}) {
  const [rows, setRows] = useState<CodingProcessRow[]>(initialRows);
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(initialPrefs.filter((p) => p.hidden).map((p) => projectKey(p.projectPath))),
  );
  const [names, setNames] = useState<Map<string, string>>(
    () =>
      new Map(
        initialPrefs
          .filter((p) => p.displayName !== null && p.displayName.trim() !== '')
          .map((p) => [projectKey(p.projectPath), p.displayName!.trim()]),
      ),
  );
  const [selected, setSelected] = useState<string | null>(null);
  // Session ouverte dans le poste de travail projet ; null = la plus récente.
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  /** Projet en cours de renommage (clé), et le texte saisi. */
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);

  function openProjectView(key: string) {
    setSelected(key);
    setSessionKey(null);
  }

  // A ref mirrors `rows` so the polling effect can read the latest list
  // without depending on it (an interval that resets every fetch would never
  // hold steady at 5s). Synced in an effect, never during render.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    const hasCoding = () => rowsRef.current.some((r) => r.stage === 'coding');
    if (!hasCoding()) return;

    const id = setInterval(() => {
      if (!hasCoding()) return;
      void listCodingProcessesAction().then((result) => {
        if (result.ok) setRows(result.data);
      });
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [rows]);

  const projects = useMemo(() => groupProjects(rows, names), [rows, names]);
  const activeProjects = projects.filter((p) => !hidden.has(p.key));
  const hiddenProjects = projects.filter((p) => p.path !== null && hidden.has(p.key));

  function toggleHidden(project: Project, nextHidden: boolean) {
    if (!project.path) return;
    const path = project.path;
    const key = project.key;
    setHidden((prev) => {
      const next = new Set(prev);
      if (nextHidden) next.add(key);
      else next.delete(key);
      return next;
    });
    void setCodeProjectHiddenAction({ projectPath: path, hidden: nextHidden }).then((r) => {
      if (!r.ok) {
        // Revert optimiste — l'état affiché ne doit jamais mentir sur la base.
        setHidden((prev) => {
          const next = new Set(prev);
          if (nextHidden) next.delete(key);
          else next.add(key);
          return next;
        });
        toast.error(r.message);
        return;
      }
      toast.success(
        nextHidden
          ? `${project.name} hidden. Agents stop seeing it too.`
          : `${project.name} is back.`,
      );
    });
  }

  function commitRename(project: Project, raw: string) {
    setRenaming(null);
    if (!project.path) return;
    const path = project.path;
    const key = project.key;
    const value = raw.trim();
    const previous = names.get(key);
    if (value === (previous ?? '')) return;

    setNames((prev) => {
      const next = new Map(prev);
      if (value === '') next.delete(key);
      else next.set(key, value);
      return next;
    });
    void renameCodeProjectAction({ projectPath: path, displayName: value }).then((r) => {
      if (!r.ok) {
        setNames((prev) => {
          const next = new Map(prev);
          if (previous === undefined) next.delete(key);
          else next.set(key, previous);
          return next;
        });
        toast.error(r.message);
        return;
      }
      // Le nom voyage jusqu'au contexte des agents : le dire, sinon on croit
      // n'avoir changé qu'une étiquette d'écran.
      toast.success(
        value === ''
          ? 'Back to the folder name.'
          : `Renamed to ${value}. Your agents use this name too.`,
      );
    });
  }

  if (error) {
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-err">
        {error}
      </div>
    );
  }

  if (rows.length === 0 && workspaceCount === 0) {
    // Tout est masqué, ou rien n'est attaché : deux situations, deux phrases.
    // Les confondre ferait dire « attache un dossier » à quelqu'un qui en a
    // dix, tous masqués de sa main.
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-ink-4">
        {hiddenWorkspaceCount > 0 ? (
          <>
            <p className="text-ink-2">
              Every folder is hidden from this tab
              {hiddenWorkspaceCount > 1 ? ` (${hiddenWorkspaceCount} of them)` : ''}.
            </p>
            <p className="mx-auto mt-2 max-w-md">
              Open an agent and untick <span className="text-ink-2">Hide from the Code tab</span> on
              a folder to see its work here again.
            </p>
          </>
        ) : (
          <>
            <p className="text-ink-2">Your agents have nowhere to write yet.</p>
            <p className="mx-auto mt-2 max-w-md">
              Open an agent and attach a folder. Anything written in there shows up here as a
              project, one per subfolder. Rename a project, or hide it if you would rather not see
              it.
            </p>
          </>
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-ink-4">
        No activity yet. Sessions that write files show up here, grouped by the folder they wrote
        in. Ask an agent to build something.
      </div>
    );
  }

  // -- Niveau 2 : le POSTE DE TRAVAIL d'un projet (décision Quentin 25/08 :
  // « si je clique sur un projet, je veux les diffs, la review, les résultats
  // de review, et explorer les sessions dans cette interface » — pas une page
  // intermédiaire qui liste des sessions). Rail de sessions à gauche, détail
  // complet (diffs / activity / verdicts / approbations) à droite.
  const openProject = selected ? projects.find((p) => p.key === selected) : null;
  if (openProject) {
    const sessions = openProject.sessions;
    const effectiveKey =
      sessionKey && sessions.some((s) => `${s.kind}-${s.id}` === sessionKey)
        ? sessionKey
        : sessions[0]
          ? `${sessions[0].kind}-${sessions[0].id}`
          : null;
    const current = sessions.find((s) => `${s.kind}-${s.id}` === effectiveKey) ?? null;
    const filesTotal = sessions.reduce((n, s) => n + s.filesChanged, 0);

    return (
      <div className="space-y-4">
        {/* En-tête projet : identité + agrégats — le résumé avant le détail. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-rule-2 bg-paper px-5 py-4">
          <TextButton onClick={() => setSelected(null)}>← Projects</TextButton>
          <span className="text-medium-15 text-ink">{openProject.name}</span>
          {openProject.path && (
            <code className="hidden text-mono-12 text-ink-4 md:inline" title={openProject.path}>
              {openProject.path}
            </code>
          )}
          <span className="ml-auto flex items-center gap-4 text-mono-12 text-ink-3">
            <span>
              {sessions.length} session{sessions.length === 1 ? '' : 's'}
            </span>
            <span>{filesTotal} files</span>
            <span>
              {openProject.totalCostUsd > 0 ? `$${openProject.totalCostUsd.toFixed(2)}` : '—'}
            </span>
            <span className="flex items-center -space-x-1.5">
              {openProject.agentNames.slice(0, 4).map((n) => (
                <AgentAvatar key={n} name={n} size="sm" shape="round" />
              ))}
            </span>
          </span>
        </div>

        {/* Sélecteur de session — le <select> natif DS, libellés COURTS et
            une seule ligne (décision Quentin 25/08, option a : le contenu
            riche appartient à l'écran en dessous, pas au sélecteur). */}
        <Select
          value={effectiveKey ?? ''}
          onChange={(e) => setSessionKey(e.target.value)}
          aria-label="Session"
        >
          {sessions.map((s) => {
            const key = `${s.kind}-${s.id}`;
            const type =
              s.sessionType === 'pr_review'
                ? 'PR review'
                : s.sessionType === 'review'
                  ? 'Review'
                  : 'Coding';
            return (
              <option key={key} value={key}>
                {type} · {s.agentName ?? 'Unknown agent'} · {stageLabel(s.stage)} ·{' '}
                {relativeTime(s.activityAt)}
              </option>
            );
          })}
        </Select>

        {/* La session sélectionnée, en PLEINE largeur, une seule colonne :
            verdict de review condensé, diffs par fichier repliables, activité
            chronologique de tous les agents — le même poste de travail que
            /code/[id], embarqué. */}
        {current ? (
          <EmbeddedProcessDetail
            key={effectiveKey}
            query={current.kind === 'job' ? { jobId: current.id } : { sessionId: current.id }}
          />
        ) : (
          <p className="rounded-xl border border-rule-2 bg-paper px-6 py-10 text-center text-body-14 text-ink-4">
            No session in this project yet.
          </p>
        )}
      </div>
    );
  }

  // -- Niveau 1 : les projets ------------------------------------------------
  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        {activeProjects.map((p) => (
          <ProjectCard
            key={p.key}
            project={p}
            renamedValue={renaming?.key === p.key ? renaming.value : null}
            onRenameChange={(v) => setRenaming({ key: p.key, value: v })}
            onRenameStart={
              p.path
                ? () => setRenaming({ key: p.key, value: names.get(p.key) ?? p.name })
                : undefined
            }
            onRenameCommit={(v) => commitRename(p, v)}
            onRenameCancel={() => setRenaming(null)}
            onOpen={() => openProjectView(p.key)}
            onHide={p.path ? () => toggleHidden(p, true) : undefined}
          />
        ))}
        {activeProjects.length === 0 && (
          <p className="rounded-2xl border border-rule-2 bg-paper px-6 py-8 text-center text-body-14 text-ink-4">
            Everything is hidden. Bring a project back from the list below.
          </p>
        )}
      </div>

      {hiddenProjects.length > 0 && (
        <div className="space-y-2.5">
          <TextButton
            onClick={() => setShowHidden((v) => !v)}
            className="!text-mono-11 uppercase tracking-[0.12em]"
          >
            {showHidden ? '▾' : '▸'} Hidden · {hiddenProjects.length}
          </TextButton>
          {showHidden &&
            hiddenProjects.map((p) => (
              <ProjectCard
                key={p.key}
                project={p}
                dimmed
                onOpen={() => openProjectView(p.key)}
                onUnhide={() => toggleHidden(p, false)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  dimmed = false,
  renamedValue = null,
  onOpen,
  onHide,
  onUnhide,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: {
  project: Project;
  dimmed?: boolean;
  /** Non-null pendant le renommage : la saisie en cours. */
  renamedValue?: string | null;
  onOpen: () => void;
  onHide?: () => void;
  onUnhide?: () => void;
  onRenameStart?: () => void;
  onRenameChange?: (v: string) => void;
  onRenameCommit?: (v: string) => void;
  onRenameCancel?: () => void;
}) {
  const live = project.sessions.some((s) => s.stage === 'coding');
  const isRenaming = renamedValue !== null;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-2xl border border-rule-2 bg-paper px-5 py-4 ${
        dimmed ? 'opacity-60' : ''
      }`}
    >
      {isRenaming ? (
        <div className="min-w-0 flex-1">
          {/*
            Renommage EN PLACE, pas de dialogue : le nom se corrige là où on
            l'a lu. Entrée valide, Échap annule, et sortir du champ vaut
            validation — un champ abandonné ne doit pas jeter la saisie en
            silence.
          */}
          <TextInput
            autoFocus
            value={renamedValue}
            maxLength={120}
            aria-label="Project name"
            onChange={(e) => onRenameChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit?.(renamedValue);
              else if (e.key === 'Escape') onRenameCancel?.();
            }}
            onBlur={() => onRenameCommit?.(renamedValue)}
          />
          <span className="mt-1 block text-body-12 text-ink-4">
            Enter to save, Escape to cancel. Empty goes back to the folder name.
          </span>
        </div>
      ) : (
        <RowActionButton
          onClick={onOpen}
          className="!h-auto !min-w-0 !flex-1 !justify-start !rounded-lg !border-transparent !bg-transparent !p-0 !text-left"
        >
          <span className="block min-w-0">
            <span className="flex items-center gap-2.5">
              <span className="truncate text-medium-15 text-ink">{project.name}</span>
              <StatusPill
                variant={stageVariant(project.latestStage)}
                label={stageLabel(project.latestStage)}
              />
              {live && <span className="animate-pulse text-body-12 text-ink-4">Live…</span>}
            </span>
            {project.path && (
              <code className="mt-0.5 block truncate text-mono-12 text-ink-4" title={project.path}>
                {project.path}
              </code>
            )}
          </span>
        </RowActionButton>
      )}

      <div className="flex shrink-0 items-center gap-4">
        <span className="flex items-center -space-x-1.5">
          {project.agentNames.slice(0, 3).map((n) => (
            <AgentAvatar key={n} name={n} size="sm" shape="round" />
          ))}
          {project.agentNames.length > 3 && (
            <span className="pl-2.5 text-mono-11 text-ink-4">+{project.agentNames.length - 3}</span>
          )}
        </span>
        <span className="text-mono-12 text-ink-3">
          {project.sessions.length} session{project.sessions.length === 1 ? '' : 's'}
        </span>
        <span className="hidden text-mono-12 text-ink-3 sm:inline">
          {project.totalCostUsd > 0 ? `$${project.totalCostUsd.toFixed(2)}` : '—'}
        </span>
        <span className="text-mono-12 text-ink-4">{relativeTime(project.lastActivityAt)}</span>
        {onRenameStart && !isRenaming && (
          <RowActionButton
            onClick={onRenameStart}
            title="Name this project. Your agents use it too."
          >
            Rename
          </RowActionButton>
        )}
        {onHide && !isRenaming && (
          <RowActionButton
            onClick={onHide}
            title="Hides it here and for your agents. The folder is untouched."
          >
            Hide
          </RowActionButton>
        )}
        {onUnhide && (
          <RowActionButton onClick={onUnhide} title="Show it again">
            Show
          </RowActionButton>
        )}
      </div>
    </div>
  );
}

// --- [retiré] Sélecteur riche (option b) — Quentin a tranché pour le select
// natif sobre : « le contenu riche appartient à l'écran, pas au sélecteur ».

/**
 * Charge puis rend le détail d'une session DANS le poste de travail projet.
 * Le composant CodeProcessDetail exige un initialDetail (la page /code/[id]
 * le fournit côté serveur) — embarqué, ce wrapper le charge côté client, avec
 * un état de chargement honnête, puis remonte à chaque changement de session
 * (key posée par l'appelant).
 */
function EmbeddedProcessDetail({ query }: { query: { jobId: string } | { sessionId: string } }) {
  const [detail, setDetail] = useState<CodingProcessDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCodingProcessDetailAction(query).then((result) => {
      if (cancelled) return;
      if (result.ok) setDetail(result.data);
      else setError(result.message);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <p className="rounded-xl border border-err/25 bg-paper px-6 py-10 text-center text-body-14 text-err">
        {error}
      </p>
    );
  }
  if (!detail) {
    // Squelette animé (retour Quentin 25/08 : sans loader, « on pense que
    // c'est planté ») — la silhouette des sections qui arrivent.
    return (
      <div className="animate-pulse space-y-4" aria-label="Loading session" role="status">
        <div className="h-24 rounded-xl border border-rule-2 bg-paper" />
        <div className="h-12 rounded-xl border border-rule-2 bg-paper" />
        <div className="space-y-0 overflow-hidden rounded-xl border border-rule-2 bg-paper">
          <div className="h-10 border-b border-rule-2 bg-hover/60" />
          <div className="h-10 border-b border-rule-2" />
          <div className="h-10 border-b border-rule-2 bg-hover/40" />
          <div className="h-10" />
        </div>
        <p className="text-center text-body-13 text-ink-4">Loading session…</p>
      </div>
    );
  }
  return <CodeProcessDetail query={query} initialDetail={detail} embedded />;
}
