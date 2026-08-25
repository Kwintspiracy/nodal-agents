'use client';

// CodeProcessesTable — la page /code, organisée PAR PROJET (décision Quentin
// 25/08) : « ce qui est intéressant, c'est de suivre le développement d'un
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
// L'ARCHIVAGE est un état d'UI persisté (code_project_archives) : le projet
// sort de l'espace actif, le dossier réel n'est jamais touché, désarchivage
// en un clic depuis la section « Archived ».
//
// Poll : listCodingProcessesAction toutes les 5s tant qu'une session est en
// 'coding' — le regroupement est recalculé à chaque rafraîchissement.

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  listCodingProcessesAction,
  getCodingProcessDetailAction,
  setCodeProjectArchivedAction,
  type CodingProcessRow,
  type CodingProcessDetail as CodingProcessDetailData,
} from '@/lib/actions.ts';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import RowActionButton from '@/components/ui/RowActionButton';
import TextButton from '@/components/ui/TextButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime } from '@/lib/format-time';
import CodeProcessDetail from './[id]/CodeProcessDetail.tsx';

const POLL_INTERVAL = 5000;

/** Clé du tiroir des sessions sans projet dérivable. Jamais archivable. */
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

function groupProjects(rows: CodingProcessRow[]): Project[] {
  const byKey = new Map<string, Project>();
  // rows arrivent triées par activité décroissante — la première session d'un
  // groupe est donc la plus récente, et l'ordre des projets suit.
  for (const row of rows) {
    const key = row.projectPath ?? OTHER_KEY;
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
        name: row.projectName ?? 'Other sessions',
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
  initialArchivedPaths,
  error,
}: {
  initialRows: CodingProcessRow[];
  initialArchivedPaths: string[];
  error?: string;
}) {
  const [rows, setRows] = useState<CodingProcessRow[]>(initialRows);
  const [archived, setArchived] = useState<Set<string>>(() => new Set(initialArchivedPaths));
  const [selected, setSelected] = useState<string | null>(null);
  // Session ouverte dans le poste de travail projet ; null = la plus récente.
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

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

  const projects = useMemo(() => groupProjects(rows), [rows]);
  const activeProjects = projects.filter((p) => p.path === null || !archived.has(p.path));
  const archivedProjects = projects.filter((p) => p.path !== null && archived.has(p.path));

  function toggleArchive(project: Project, nextArchived: boolean) {
    if (!project.path) return;
    const path = project.path;
    setArchived((prev) => {
      const next = new Set(prev);
      if (nextArchived) next.add(path);
      else next.delete(path);
      return next;
    });
    void setCodeProjectArchivedAction({ projectPath: path, archived: nextArchived }).then((r) => {
      if (!r.ok) {
        // Revert optimiste — l'état affiché ne doit jamais mentir sur la base.
        setArchived((prev) => {
          const next = new Set(prev);
          if (nextArchived) next.delete(path);
          else next.add(path);
          return next;
        });
        toast.error(r.message);
        return;
      }
      toast.success(
        nextArchived
          ? `${project.name} archived. The folder itself is untouched.`
          : `${project.name} restored.`,
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

  if (rows.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-ink-4">
        No coding activity yet. Every pipeline that edits code files shows up here — grouped by
        project (the git repo or workspace it touched). Ask an agent to write some code and watch
        the project appear.
      </div>
    );
  }

  // ── Niveau 2 : le POSTE DE TRAVAIL d'un projet (décision Quentin 25/08 :
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

        {/* Sélecteur de session — un dropdown RICHE (retour Quentin 25/08 :
            le <select> natif était « borrin et trop fin ») : la session
            courante s'affiche en carte pleine (type, agent, tâche, étape,
            âge), le panneau liste les autres avec les mêmes ingrédients. */}
        <SessionPicker
          sessions={sessions}
          selectedKey={effectiveKey}
          onSelect={(key) => setSessionKey(key)}
        />

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

  // ── Niveau 1 : les projets ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        {activeProjects.map((p) => (
          <ProjectCard
            key={p.key}
            project={p}
            onOpen={() => openProjectView(p.key)}
            onArchive={p.path ? () => toggleArchive(p, true) : undefined}
          />
        ))}
        {activeProjects.length === 0 && (
          <p className="rounded-2xl border border-rule-2 bg-paper px-6 py-8 text-center text-body-14 text-ink-4">
            Everything is archived. Restore a project below to bring it back.
          </p>
        )}
      </div>

      {archivedProjects.length > 0 && (
        <div className="space-y-2.5">
          <TextButton
            onClick={() => setShowArchived((v) => !v)}
            className="!text-mono-11 uppercase tracking-[0.12em]"
          >
            {showArchived ? '▾' : '▸'} Archived · {archivedProjects.length}
          </TextButton>
          {showArchived &&
            archivedProjects.map((p) => (
              <ProjectCard
                key={p.key}
                project={p}
                dimmed
                onOpen={() => openProjectView(p.key)}
                onUnarchive={() => toggleArchive(p, false)}
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
  onOpen,
  onArchive,
  onUnarchive,
}: {
  project: Project;
  dimmed?: boolean;
  onOpen: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}) {
  const live = project.sessions.some((s) => s.stage === 'coding');
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-2xl border border-rule-2 bg-paper px-5 py-4 ${
        dimmed ? 'opacity-60' : ''
      }`}
    >
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
        {onArchive && (
          <RowActionButton onClick={onArchive} title="Archive (UI only — the folder is untouched)">
            Archive
          </RowActionButton>
        )}
        {onUnarchive && (
          <RowActionButton onClick={onUnarchive} title="Restore to the active list">
            Restore
          </RowActionButton>
        )}
      </div>
    </div>
  );
}

// ─── Sélecteur de session riche ──────────────────────────────────────────────

function sessionTypeLabel(t: CodingProcessRow['sessionType']): string {
  return t === 'pr_review' ? 'PR REVIEW' : t === 'review' ? 'REVIEW' : 'CODING';
}

/** La ligne riche d'une session — partagée entre le déclencheur et le panneau. */
function SessionSummary({ s }: { s: CodingProcessRow }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <AgentAvatar name={s.agentName ?? '?'} size="sm" shape="round" />
      <MonoMicroTag tone={s.sessionType === 'coding' ? 'ink' : 'agent'}>
        {sessionTypeLabel(s.sessionType)}
      </MonoMicroTag>
      <span className="min-w-0 flex-1 truncate text-body-14 text-ink" title={s.task}>
        {s.task}
      </span>
      <StatusPill variant={stageVariant(s.stage)} label={stageLabel(s.stage)} />
      {s.filesChanged > 0 && (
        <span className="hidden shrink-0 text-mono-11 text-ink-4 sm:inline">
          {s.filesChanged} files
        </span>
      )}
      <span className="shrink-0 text-mono-11 text-ink-4">{relativeTime(s.activityAt)}</span>
    </span>
  );
}

function SessionPicker({
  sessions,
  selectedKey,
  onSelect,
}: {
  sessions: CodingProcessRow[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fermeture au clic extérieur + Échap — le contrat minimal d'un popover.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = sessions.find((s) => `${s.kind}-${s.id}` === selectedKey) ?? sessions[0] ?? null;
  if (!current) return null;

  return (
    <div ref={rootRef} className="relative">
      <RowActionButton
        onClick={() => setOpen((v) => !v)}
        className="!h-auto !w-full !justify-start !rounded-xl !border-rule-2 !bg-paper !px-4 !py-3"
      >
        <SessionSummary s={current} />
        <span className="ml-3 shrink-0 text-body-12 text-ink-4">
          {open ? '▴' : '▾'} {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
      </RowActionButton>

      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-2 max-h-96 overflow-y-auto rounded-xl border border-rule-2 bg-paper shadow-2xl">
          {sessions.map((s) => {
            const key = `${s.kind}-${s.id}`;
            const isCurrent = key === (selectedKey ?? `${sessions[0]!.kind}-${sessions[0]!.id}`);
            return (
              <div key={key} className="border-b border-rule-2 last:border-b-0">
                <RowActionButton
                  onClick={() => {
                    onSelect(key);
                    setOpen(false);
                  }}
                  className={`!h-auto !w-full !justify-start !rounded-none !border-transparent !px-4 !py-3 ${
                    isCurrent ? '!bg-hover' : '!bg-transparent'
                  }`}
                >
                  <SessionSummary s={s} />
                </RowActionButton>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
