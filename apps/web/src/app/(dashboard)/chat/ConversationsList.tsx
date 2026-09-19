'use client';

// ConversationsList — le dossier « Nodal chats » : ses conversations, et ce
// qu'on peut en faire.
//
// Elle listait aussi les fils de canal (P7). Ils ont leur tableau à part
// depuis le 08/09 : un chat ne se ferme jamais et ne se supprime pas, alors
// qu'une conversation d'ici est jetable — on l'ouvre d'un bouton, on la
// supprime, l'IA la renomme.
//
// DEUX CHANGEMENTS DU 18/09, tous deux dits par Quentin en ouvrant le dossier.
//
// 1. « Je n'ai plus d'option pour créer un nouveau chat. » Le dossier ouvert
//    depuis le menu rendait la liste de la planche #135 SANS barre d'actions :
//    créer, chercher et supprimer ne vivaient plus que dans la vue entière, que
//    le menu n'ouvre plus. La barre revient ici, et c'est le même composant qui
//    sert les deux vues — deux listes parallèles auraient divergé au premier
//    correctif.
// 2. « Il faut juste un titre de conversation. » Les lignes sont celles de la
//    planche (`ConversationRow`), mais SANS agent ni dernier message : voir
//    `conversation-rows.ts`. Le tableau à six colonnes disparaît avec elles, et
//    la corbeille par ligne avec lui — une ligne est un lien, et supprimer
//    passe par le mode « Select », qui était déjà la seconde façon de le faire.
//
// ET UN DU 19/09 (#248) : « New conversation » n'écrit plus rien. C'est un lien
// vers l'écran de conversation neuve (`/`), et c'est le premier message envoyé
// qui fait naître la ligne. Le bouton créait le fil puis y menait : une visite
// sans un mot laissait un fil vide dans ce dossier, pour toujours.
//
// Le filtre reste côté client : deux cents lignes tiennent en mémoire, et
// taper doit répondre à la frappe.

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Checkbox from '@/components/ui/Checkbox';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import ConversationRow from '@/components/ui/ConversationRow';
import EmptyState from '@/components/ui/EmptyState';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { deleteConversationsAction } from '@/lib/actions.ts';
import type { ConversationRowModel } from './conversation-rows.ts';

export default function ConversationsList({ rows }: { rows: ConversationRowModel[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  /**
   * Le MODE sélection. Les cases ne sont pas là en permanence : on entre en
   * sélection par le bouton « Select », et on en sort par « Cancel » (Quentin,
   * 07/09 : « la checkbox visible en permanence, c'est la pire UX ; il
   * pourrait y avoir un bouton Select qui déclenche l'apparition du toggle »).
   */
  const [selecting, setSelecting] = useState(false);
  /**
   * Les conversations COCHÉES. Un ensemble d'identifiants, pas d'index : la
   * recherche filtre la liste sous les pieds de la sélection, et un index
   * aurait désigné une autre ligne.
   */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** La suppression EN MASSE attend sa confirmation. */
  const [confirmMass, setConfirmMass] = useState(false);
  const [isPending, startTransition] = useTransition();

  // La recherche porte sur le TITRE, qui est tout ce que la ligne montre
  // désormais : chercher dans un champ invisible rendrait des lignes dont rien
  // n'expliquerait la présence.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return rows;
    return rows.filter((r) => r.chatName.toLowerCase().includes(q));
  }, [rows, query]);

  // Ce qui est coché ET encore visible : cocher, chercher autre chose, puis
  // supprimer ne doit pas emporter des lignes qu'on ne voit plus.
  const visiblePicked = useMemo(
    () => filtered.map((r) => r.id).filter((id): id is string => id !== null && picked.has(id)),
    [filtered, picked],
  );
  const allVisiblePicked = filtered.length > 0 && visiblePicked.length === filtered.length;

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

  function toggleAllVisible(): void {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const r of filtered) {
        if (r.id === null) continue;
        if (allVisiblePicked) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  }

  function confirmMassDelete(): void {
    const ids = visiblePicked;
    setConfirmMass(false);
    if (ids.length === 0) return;
    startTransition(async () => {
      const r = await deleteConversationsAction(ids);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      // Le compte RÉEL : une ligne déjà partie ne se compte pas.
      toast.success(
        r.data.deleted === 1 ? '1 conversation deleted' : `${r.data.deleted} conversations deleted`,
      );
      leaveSelection();
      router.refresh();
    });
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {selecting ? (
          <>
            <span className="text-body-13 text-ink-2">
              {visiblePicked.length === 0
                ? 'Select conversations to delete'
                : `${visiblePicked.length} selected`}
            </span>
            <PrimaryButton
              variant="danger"
              size="sm"
              onClick={() => setConfirmMass(true)}
              disabled={isPending || visiblePicked.length === 0}
            >
              Delete
            </PrimaryButton>
            {filtered.length > 0 && (
              // Tout cocher vivait dans l'en-tête du tableau. Le tableau est
              // parti ; le geste reste, dans la barre, sinon vider un dossier
              // de cinquante fils redevient cinquante clics.
              <PrimaryButton variant="neutral" size="sm" onClick={toggleAllVisible}>
                {allVisiblePicked ? 'Clear selection' : 'Select all'}
              </PrimaryButton>
            )}
            <PrimaryButton variant="neutral" size="sm" onClick={leaveSelection}>
              Cancel
            </PrimaryButton>
          </>
        ) : (
          <>
            {/* #248 — un LIEN, plus un bouton qui crée. Ouvrir une conversation
                n'écrit plus rien : on va sur l'écran vide, et c'est le premier
                message qui fait naître la ligne. Sans ROOT, c'est cet écran qui
                le dit, à un seul endroit, au lieu d'un clic qui échoue ici. */}
            <PrimaryButton href="/">New conversation</PrimaryButton>
            {rows.length > 0 && (
              <PrimaryButton variant="neutral" size="sm" onClick={() => setSelecting(true)}>
                Select
              </PrimaryButton>
            )}
          </>
        )}
        <PageSearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search conversations…"
          className="ml-auto"
        />
      </div>

      {/* L'avertissement « No ROOT agent yet » vivait ici, levé par l'échec du
          clic. Il vit maintenant sur l'écran de conversation neuve, là où la
          saisie serait (#248) : c'est le seul endroit où l'absence de ROOT
          empêche vraiment quelque chose, et le dire deux fois faisait deux
          formulations à tenir. */}

      {filtered.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? 'No conversation yet' : 'No conversation matches that.'}
          description={
            rows.length === 0
              ? 'Start one here, or write to your agent from one of its channels.'
              : undefined
          }
        />
      ) : (
        // Pas d'écart entre les lignes : la planche les sépare d'un trait, dans
        // une seule boîte. `overflow-hidden` fait suivre les coins arrondis à la
        // première et à la dernière.
        <div className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper">
          {filtered.map(({ key, ...ligne }) => {
            const id = ligne.id;
            return selecting && id !== null ? (
              // La case vit À CÔTÉ de la ligne, jamais dedans : la ligne est un
              // lien, et une case posée à l'intérieur d'un lien ne se coche pas.
              <div key={key} className="flex items-center bg-paper">
                <span className="pl-4">
                  <Checkbox
                    checked={picked.has(id)}
                    onChange={() => toggle(id)}
                    aria-label={`Select ${ligne.chatName}`}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <ConversationRow rowKey={key} {...ligne} />
                </span>
              </div>
            ) : (
              <ConversationRow key={key} rowKey={key} {...ligne} />
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmMass}
        title={
          visiblePicked.length === 1
            ? 'Delete this conversation?'
            : `Delete ${visiblePicked.length} conversations?`
        }
        message="Their turns will be removed. The work they produced stays."
        confirmLabel="Delete"
        onConfirm={confirmMassDelete}
        onCancel={() => setConfirmMass(false)}
      />
    </>
  );
}
