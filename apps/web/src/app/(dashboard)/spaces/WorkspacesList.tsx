'use client';

// WorkspacesList — UNE liste de projets, registre et détection confondus (#143).
//
// La planche (page « #143 Workspaces are the only projects page », écran
// 444:210) : une ligne par projet — l'avatar de l'agent responsable, le nom, une
// sous-ligne qui dit le dossier, l'agent et ce qui s'y est passé, l'heure à
// droite, et la pastille de preuve. Même géométrie que la boîte de réception
// d'un dossier de chat : un trait entre les lignes, une seule boîte.
//
// Les dossiers DÉTECTÉS — ceux où un agent a écrit sans que personne les ait
// déclarés — sont dans la MÊME liste, marqués « Detected », avec les deux
// gestes que l'onglet Code portait :
//
//   REGISTER — les inscrit au registre, avec l'agent qui a écrit comme
//              responsable. Ils deviennent des projets ordinaires.
//   HIDE     — les retire de la liste. Le dossier n'est JAMAIS touché, et le
//              geste se défait depuis « N hidden folder · Show ».
//
// RENOMMER reste sur un projet OUVERT : c'est un geste qu'on pose en regardant
// le projet, pas en balayant une liste de cinquante.
//
// Ce composant DESSINE et APPELLE les deux actions ; il ne décide rien. La
// fusion, les comptes et la pastille vivent dans `lib/workspaces.ts`, prouvés
// sans navigateur.

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import AgentAvatar from '@/components/ui/AgentAvatar';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import TextButton from '@/components/ui/TextButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime, truncate } from '@/lib/format-time';
// La MÊME langue d'heure que les boîtes de réception (`14:02`, `Mon`,
// `Sep 12`) : deux listes de la même application ne datent pas une ligne de
// deux façons.
import { conversationTimeLabel } from '@/app/(dashboard)/chat/conversation-rows.ts';
// Les deux actions sont importées de LEUR module, jamais réexportées par un
// troisième : un fichier 'use server' qui en réexporte un autre casse le
// repérage des actions de Next.
import { setCodeProjectHiddenAction } from '@/lib/actions.ts';
import { registerDetectedProjectAction } from '@/lib/project-actions.ts';
import type { WorkspaceProof, WorkspaceRow, WorkspacesView } from '@/lib/workspaces.ts';

/** Le chemin, raccourci par la GAUCHE : la fin d'un chemin est ce qui le nomme. */
function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - max + 1)}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Ce que la sous-ligne DIT, morceau par morceau — exporté pour être prouvé
 * sans navigateur.
 *
 * Rien d'absent ne se dessine (invariant #4) : pas de « 0 conversations » sous
 * un dossier détecté dont personne n'a compté les conversations, pas de
 * « never » sous un projet neuf. Un projet du registre sans aucune session ne
 * ment pas non plus : il dit « no session ».
 */
export function workspaceSubline(row: WorkspaceRow): string {
  const parts: string[] = [shortPath(row.path)];
  if (row.kind === 'detected') {
    if (row.agentName) parts.push(`${row.agentName} wrote here`);
    parts.push(plural(row.sessions, 'session', 'sessions'));
    parts.push('not registered yet');
    return parts.join(' · ');
  }
  if (row.agentName) parts.push(row.agentName);
  if (row.conversations !== null) {
    parts.push(plural(row.conversations, 'conversation', 'conversations'));
  }
  parts.push(row.sessions === 0 ? 'no session' : plural(row.sessions, 'session', 'sessions'));
  // « last activity 2h ago » : le TEMPS ÉCOULÉ, quand la colonne de droite dit
  // l'heure au cadran. Les deux ne se répètent pas — l'une répond « quand »,
  // l'autre « il y a combien de temps ».
  if (row.lastActivityAt) parts.push(`last activity ${relativeTime(row.lastActivityAt)}`);
  return parts.join(' · ');
}

/** La pastille de preuve : quatre états, quatre mots. */
const PROOF: Record<WorkspaceProof, { variant: 'done' | 'warn' | 'idle'; label: string }> = {
  verified: { variant: 'done', label: 'Verified' },
  failed: { variant: 'warn', label: 'Failed' },
  approval_pending: { variant: 'warn', label: 'Approval pending' },
  unverified: { variant: 'idle', label: 'Unverified' },
};

/** Hauteur, gouttière et marges de la planche — identiques avec ou sans lien. */
const ROW = 'flex min-h-14 items-center gap-3.5 px-4 py-2';

function RowBody({ row }: { row: WorkspaceRow }) {
  const proof = PROOF[row.proof];
  return (
    <>
      <AgentAvatar
        name={row.agentName ?? row.name}
        imageUrl={row.agentAvatarUrl}
        size="md"
        shape="square"
      />
      {/* min-w-0 : sans lui, un chemin long refuse de se couper et pousse
          l'heure et la pastille hors de la ligne. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {row.kind === 'detected' && (
            <MonoMicroTag tone="ink" className="shrink-0">
              Detected
            </MonoMicroTag>
          )}
          <span className="truncate text-medium-14 text-ink">{truncate(row.name, 60)}</span>
          {/* Un projet de DOCUMENTS se dit : il n'exécute pas de commande, et
              sa pastille de preuve ne veut pas dire la même chose. Le code est
              le cas ordinaire et n'a pas besoin d'étiquette. */}
          {row.produces === 'documents' && (
            <MonoMicroTag tone="ink" className="shrink-0">
              documents
            </MonoMicroTag>
          )}
          {row.hidden && (
            <MonoMicroTag tone="warn" className="shrink-0">
              hidden
            </MonoMicroTag>
          )}
        </span>
        <span className="truncate text-body-13 text-ink-3">{workspaceSubline(row)}</span>
      </span>
      {/* L'heure, `null` quand la date manque : la colonne reste VIDE plutôt
          que de porter un tiret qu'on lirait comme une valeur. */}
      {conversationTimeLabel(row.lastActivityAt) !== null && (
        <span className="shrink-0 text-mono-11 text-ink-4">
          {conversationTimeLabel(row.lastActivityAt)}
        </span>
      )}
      <StatusPill variant={proof.variant} label={proof.label} className="shrink-0" />
    </>
  );
}

function DetectedActions({ row, onDone }: { row: WorkspaceRow; onDone: () => void }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run(call: () => Promise<{ ok: boolean; message?: string }>) {
    start(async () => {
      const result = await call();
      if (!result.ok) {
        // Un échec est DIT, et rien ne bouge : rafraîchir sur un refus
        // redessinerait la même ligne en laissant croire à un geste appliqué.
        toast.error(result.message ?? 'The action failed');
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <span className="flex shrink-0 items-center gap-2 pr-4">
      {row.hidden ? (
        <RowActionButton
          disabled={pending}
          onClick={() =>
            run(() => setCodeProjectHiddenAction({ projectPath: row.path, hidden: false }))
          }
          title="Show it again"
        >
          Show
        </RowActionButton>
      ) : (
        <>
          <RowActionButton
            disabled={pending}
            onClick={() =>
              run(() => registerDetectedProjectAction({ projectPath: row.path, agentId: null }))
            }
            title="Keep this folder as a project, with the agent that wrote in it."
          >
            Register
          </RowActionButton>
          <RowActionButton
            disabled={pending}
            onClick={() =>
              run(() => setCodeProjectHiddenAction({ projectPath: row.path, hidden: true }))
            }
            title="Hides it here and for your agents. The folder is untouched."
          >
            Hide
          </RowActionButton>
        </>
      )}
    </span>
  );
}

function Row({ row, onDone }: { row: WorkspaceRow; onDone: () => void }) {
  // Un dossier détecté n'a PAS de page : il n'est pas au registre, donc il n'a
  // pas d'id. La ligne reste entière et ne feint pas un lien (invariant #4) ;
  // « Register » est justement le geste qui lui en donne un.
  if (row.kind === 'detected') {
    return (
      <div className="flex items-center" data-testid={`workspace-row-${row.key}`}>
        <div className={`${ROW} min-w-0 flex-1`}>
          <RowBody row={row} />
        </div>
        <DetectedActions row={row} onDone={onDone} />
      </div>
    );
  }
  return (
    <Link
      href={`/spaces/${row.id}`}
      className={`${ROW} hover:bg-hover`}
      data-testid={`workspace-row-${row.key}`}
    >
      <RowBody row={row} />
    </Link>
  );
}

export default function WorkspacesList({ view }: { view: WorkspacesView }) {
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = view.hiddenDetected.length;
  const hiddenListId = useId();

  return (
    <div>
      {/* Pas d'écart entre les lignes : la planche les sépare d'un trait, dans
          une seule boîte. `overflow-hidden` fait suivre les coins arrondis à la
          première et à la dernière. */}
      <div className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper">
        {view.rows.map((row) => (
          <Row key={row.key} row={row} onDone={() => setShowHidden(false)} />
        ))}
        {showHidden && (
          <div id={hiddenListId} className="divide-y divide-rule-2">
            {view.hiddenDetected.map((row) => (
              <Row key={row.key} row={row} onDone={() => setShowHidden(true)} />
            ))}
          </div>
        )}
      </div>

      <p className="mt-3 text-body-12 text-ink-4">
        A row: the responsible agent, the project, its folder, its counts, the last activity, and
        its proof. Detected folders are projects Nodal found by itself; Register keeps them, Hide
        removes them from the list
        {hiddenCount > 0 ? (
          <>
            {' ('}
            {plural(hiddenCount, 'hidden folder', 'hidden folders')}
            {' · '}
            <TextButton
              className="underline underline-offset-2 hover:text-ink-2"
              aria-expanded={showHidden}
              aria-controls={hiddenListId}
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? 'Hide again' : 'Show'}
            </TextButton>
            {')'}
          </>
        ) : null}
        .
      </p>
    </div>
  );
}
