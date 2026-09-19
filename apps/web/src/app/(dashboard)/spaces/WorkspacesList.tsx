'use client';

// WorkspacesList — UNE liste de projets, registre et détection confondus (#143).
//
// UNE LIGNE DIT QUATRE CHOSES, et pas une de plus (Quentin, 19/09) : la marque
// du dossier, le NOM du projet, son CHEMIN, la DATE où il est apparu, et sa
// PREUVE. Même géométrie que la boîte de réception d'un dossier de chat : un
// trait entre les lignes, une seule boîte.
//
// La planche (écran 444:210) en dessinait davantage : l'avatar de l'agent
// responsable, son nom, le compte de conversations et de sessions, la dernière
// activité. Tout cela est parti le 19/09, sur un constat de Quentin : on parle
// toujours au MÊME orchestrateur, donc son visage et son nom étaient la même
// colonne répétée sur toute la liste. Les comptes, eux, n'aidaient pas à
// RETROUVER un projet, qui est ce qu'on vient faire ici.
//
// (Le nom de cet orchestrateur ne s'écrit nulle part dans le source, pas même
// dans ce commentaire : invariant #1, et `architecture.test.ts` le vérifie.)
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
import { Folder } from '@phosphor-icons/react/dist/ssr';
import Disc from '@/components/ui/Disc';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import TextButton from '@/components/ui/TextButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { truncate } from '@/lib/format-time';
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
  const proof = row.proof === null ? null : PROOF[row.proof];
  return (
    <>
      {/* UN DOSSIER, pas un visage (Quentin, 19/09). La ligne portait l'avatar
          de l'agent responsable ; il est systématiquement l'orchestrateur, donc
          le même sur toutes les lignes — une colonne qui n'apprend rien. Ce
          que la ligne EST, c'est un dossier, et la marque le dit.
          `Disc` est la primitive du DS pour une icône dans une case : même
          géométrie et même fond que l'avatar carré qu'elle remplace. */}
      <Disc variant="neutral" size="sm" shape="square">
        {/* DÉCORATIVE : le nom du projet est juste à côté, et un lecteur
            d'écran qui annoncerait « dossier » avant chaque ligne d'une liste de
            dossiers ne dirait rien de plus. */}
        <Folder weight="fill" aria-hidden />
      </Disc>
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
        {/* LE CHEMIN, et rien d'autre (Quentin, 19/09). La sous-ligne comptait
            les conversations, les sessions et la dernière activité, et nommait
            l'agent responsable ; rien de tout cela n'aide à retrouver un
            projet dans une liste. Le titre attribut garde le chemin ENTIER :
            la coupe est un fait d'affichage, pas une perte. */}
        <span className="truncate text-mono-12 text-ink-3" title={row.path}>
          {shortPath(row.path)}
        </span>
      </span>
      {/* LA DATE : au registre pour un projet, première écriture vue pour un
          dossier détecté. `null` quand rien ne la donne — la colonne reste
          VIDE plutôt que de porter un tiret qu'on lirait comme une valeur. */}
      {conversationTimeLabel(row.createdAt) !== null && (
        <span className="shrink-0 text-mono-11 text-ink-4" title={row.createdAt?.toISOString()}>
          {conversationTimeLabel(row.createdAt)}
        </span>
      )}
      {proof !== null && (
        <StatusPill variant={proof.variant} label={proof.label} className="shrink-0" />
      )}
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
        A row: the project, its folder, when it appeared, and its proof. Detected folders are
        projects Nodal found by itself; Register keeps them, Hide removes them from the list
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
