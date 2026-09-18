'use client';

// RunsFolderList — la liste du dossier MCP : ses pages, et ce qu'on peut en
// faire (#183).
//
// Elle était rendue par le serveur, d'un bloc, avec toute la table. Deux
// choses l'ont fait passer au client, et ce sont les deux demandes de Quentin
// sur la PR #179 :
//
//   1. UNE PAGE À LA FOIS. La base du propriétaire porte déjà plus de cent
//      runs de tête, et c'est une machine qui les crée : leur nombre ne fait
//      que monter. « Load more » demande la suivante par CURSEUR — pas par
//      rang, qui se décale dès qu'un run arrive pendant qu'on lit
//      (lib/external-runs-cursor.ts) ;
//   2. UN MODE SÉLECTION, le même geste que « Nodal chats » (PR #159) :
//      Select, Select all, Delete, et la confirmation par `<ConfirmDialog />`
//      — jamais un dialogue natif (invariant #10).
//
// Ce qu'elle N'A TOUJOURS PAS, et l'absence reste une décision : ni saisie, ni
// « New conversation ». Un run venu de dehors ne s'ouvre pas d'ici, c'est une
// machine qui le demande ; un bouton qui créerait une conversation la rangerait
// dans « Nodal chats », pas dans ce dossier.
//
// ⚠️ UN RUN VIVANT NE SE SUPPRIME PAS. Sa case est désactivée et la barre dit
// pourquoi. La règle vit dans `runIsDeletable` (run-rows.ts) et l'action la
// REFAIT côté serveur : un écran n'est pas une garde.

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Checkbox from '@/components/ui/Checkbox';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import ConversationRow from '@/components/ui/ConversationRow';
import EmptyState from '@/components/ui/EmptyState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import {
  deleteExternalRunsAction,
  listExternalRunsAction,
  type ExternalRunRow,
} from '@/lib/conversation-actions.ts';
import { runIsDeletable } from '@/lib/external-runs.ts';
import { runRows, type WaitingOnRun } from './run-rows.ts';

export type RunsFolderListProps = {
  /** La PREMIÈRE page, rendue par le serveur : la liste s'affiche remplie. */
  initialRuns: ExternalRunRow[];
  /** Où reprendre. `null` = il n'y a rien après, et aucun bouton ne le promet. */
  initialCursor: string | null;
  /**
   * Les demandes en attente, toutes provenances confondues — la MÊME lecture
   * que le menu et que le sous-titre. Elles couvrent les pages suivantes sans
   * être relues : une demande se rattache à un run par son job de TÊTE, pas
   * par la page où ce run s'affiche.
   */
  waiting: WaitingOnRun[];
};

export default function RunsFolderList({
  initialRuns,
  initialCursor,
  waiting,
}: RunsFolderListProps) {
  const router = useRouter();
  const [runs, setRuns] = useState<ExternalRunRow[]>(initialRuns);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  /** La lecture d'une page a échoué. Se DIT, plutôt que de s'arrêter en silence. */
  const [loadError, setLoadError] = useState(false);
  const [selecting, setSelecting] = useState(false);
  /**
   * Les runs COCHÉS, par identifiant et non par rang : « Load more » ajoute des
   * lignes sous les pieds de la sélection, et un index aurait désigné une autre.
   */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirmMass, setConfirmMass] = useState(false);
  const [isPending, startTransition] = useTransition();

  const rows = useMemo(() => runRows({ runs, waiting }), [runs, waiting]);
  /** Ce qu'on peut cocher : les runs terminés, et eux seuls. */
  const deletable = useMemo(
    () => runs.filter((r) => runIsDeletable(r.status)).map((r) => r.id),
    [runs],
  );
  const deletableSet = useMemo(() => new Set(deletable), [deletable]);
  const bloques = runs.length - deletable.length;
  const chosen = useMemo(() => deletable.filter((id) => picked.has(id)), [deletable, picked]);
  const allPicked = deletable.length > 0 && chosen.length === deletable.length;

  function leaveSelection(): void {
    setSelecting(false);
    setPicked(new Set());
  }

  function toggle(id: string): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setPicked(allPicked ? new Set() : new Set(deletable));
  }

  function loadMore(): void {
    if (cursor === null) return;
    setLoadError(false);
    startTransition(async () => {
      const r = await listExternalRunsAction({ cursor });
      if (!r.ok) {
        setLoadError(true);
        toast.error(r.message);
        return;
      }
      // Dédoublonné par identifiant : si un run part entre les deux lectures,
      // la borne peut ramener une ligne déjà affichée, et deux lignes de même
      // clé casseraient le rendu.
      setRuns((prev) => {
        const vus = new Set(prev.map((x) => x.id));
        return [...prev, ...r.data.runs.filter((x) => !vus.has(x.id))];
      });
      setCursor(r.data.nextCursor);
    });
  }

  function confirmMassDelete(): void {
    const ids = chosen;
    setConfirmMass(false);
    if (ids.length === 0) return;
    startTransition(async () => {
      const r = await deleteExternalRunsAction(ids);
      if (!r.ok) {
        // LE MESSAGE SEUL, sans le code (Reviewer C, passe 2, mineur retenu et
        // écarté). Aucun écran de ce produit n'affiche de slug d'erreur, et
        // celui-ci — `chain_too_deep` — n'apprend rien à qui lit : le message
        // dit déjà ce qui s'est passé ET que rien n'a été supprimé. Le code vit
        // dans le journal du serveur, à côté de l'identifiant du job, c'est-à-dire
        // là où on le cherche quand on cherche.
        toast.error(r.message);
        return;
      }
      // CE QUI EST VRAIMENT PARTI, nommé par l'action — pas ce qu'on avait
      // coché (Reviewer C, passe 1). Un run reparti entre le clic et l'écriture
      // est refusé : la liste retirait quand même sa ligne, et le message disait
      // à côté qu'il restait. `router.refresh()` ne la ramenait pas, l'état de
      // cette liste survivant jusqu'à un rechargement complet.
      const partis = new Set(r.data.deletedIds);
      setRuns((prev) => prev.filter((x) => !partis.has(x.id)));
      toast.success(partis.size === 1 ? '1 run deleted' : `${partis.size} runs deleted`);
      const restes = r.data.skippedLiveIds.length;
      if (restes > 0) {
        toast.error(
          restes === 1
            ? '1 run was left: it started again before the delete.'
            : `${restes} runs were left: they started again before the delete.`,
        );
      }
      leaveSelection();
      // La barre latérale compte ces runs elle aussi : sans ce rafraîchissement,
      // son chiffre resterait celui d'avant la suppression.
      router.refresh();
    });
  }

  if (rows.length === 0) {
    return <EmptyState title="No run started from outside Nodal yet." />;
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {selecting ? (
          <>
            <span className="text-body-13 text-ink-2">
              {chosen.length === 0 ? 'Select runs to delete' : `${chosen.length} selected`}
            </span>
            <PrimaryButton
              variant="danger"
              size="sm"
              onClick={() => setConfirmMass(true)}
              disabled={isPending || chosen.length === 0}
            >
              Delete
            </PrimaryButton>
            {deletable.length > 0 && (
              <PrimaryButton variant="neutral" size="sm" onClick={toggleAll}>
                {allPicked ? 'Clear selection' : 'Select all'}
              </PrimaryButton>
            )}
            <PrimaryButton variant="neutral" size="sm" onClick={leaveSelection}>
              Cancel
            </PrimaryButton>
          </>
        ) : (
          <PrimaryButton variant="neutral" size="sm" onClick={() => setSelecting(true)}>
            Select
          </PrimaryButton>
        )}
      </div>

      {/* La raison est dite UNE fois, au-dessus, plutôt que répétée sur chaque
          ligne bloquée : une case grise sans explication se lit comme une
          panne, et une étiquette par ligne mangerait la largeur du titre. */}
      {selecting && bloques > 0 && (
        <p className="mb-4 text-body-13 text-ink-3">
          {bloques === 1
            ? '1 run is still going, so it can’t be deleted yet.'
            : `${bloques} runs are still going, so they can’t be deleted yet.`}
        </p>
      )}

      {/* Pas d'écart entre les lignes : un trait les sépare dans une seule
          boîte, et `overflow-hidden` fait suivre les coins arrondis à la
          première et à la dernière — la même boîte que les dossiers de canal. */}
      <div
        className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper"
        data-testid="mcp-runs"
      >
        {rows.map(({ key, ...ligne }) => {
          const id = ligne.id;
          if (!selecting || id === null) {
            return <ConversationRow key={key} rowKey={key} {...ligne} />;
          }
          const supprimable = deletableSet.has(id);
          return (
            // La case vit À CÔTÉ de la ligne, jamais dedans : la ligne est un
            // lien, et une case posée à l'intérieur d'un lien ne se coche pas.
            <div key={key} className="flex items-center bg-paper">
              <span className="pl-4">
                <Checkbox
                  checked={picked.has(id)}
                  disabled={!supprimable}
                  onChange={() => toggle(id)}
                  aria-label={
                    supprimable
                      ? `Select ${ligne.chatName}`
                      : `${ligne.chatName} is still going and can’t be deleted yet`
                  }
                />
              </span>
              <span className="min-w-0 flex-1">
                <ConversationRow rowKey={key} {...ligne} />
              </span>
            </div>
          );
        })}
      </div>

      {loadError && (
        <p className="mt-4 text-body-12 text-err">
          The next runs couldn’t be read just now. Try again in a moment.
        </p>
      )}

      {cursor !== null && (
        <div className="mt-4 flex justify-center">
          <PrimaryButton variant="neutral" size="sm" onClick={loadMore} disabled={isPending}>
            {isPending ? 'Loading…' : 'Load more'}
          </PrimaryButton>
        </div>
      )}

      <ConfirmDialog
        open={confirmMass}
        title={chosen.length === 1 ? 'Delete this run?' : `Delete ${chosen.length} runs?`}
        // Les DÉLÉGUÉS sont nommés en premier (Reviewer C, passe 1) :
        // supprimer un run emporte les runs qu'il a confiés à d'autres agents,
        // et c'est la conséquence la moins attendue des quatre.
        message="Their delegated runs, steps, tool calls and pending requests go with them. What they already cost stays counted."
        confirmLabel="Delete"
        onConfirm={confirmMassDelete}
        onCancel={() => setConfirmMass(false)}
      />
    </>
  );
}
