'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useDockedFormCta } from './DockedFormCta.tsx';

/**
 * SetCtaRow — right-aligned Cancel + Save buttons for settings form sections.
 * `onCancel` is required (handler). `pending` disables Save and shows "Saving…".
 *
 * Dans un panneau ancré (#231), il ne s'affiche PAS : la planche P1 met ces
 * deux boutons au bas du panneau, pas au bout du formulaire. Il annonce alors
 * ce qu'il aurait affiché — libellé, attente, geste d'annulation — et le pied
 * du panneau les rend. Voir `DockedFormCta.tsx` : c'est ce qui permet de
 * déplacer les actions des dix formulaires sans toucher à la logique d'un
 * seul.
 */
export function SetCtaRow({
  onCancel,
  pending,
  saveLabel = 'Save',
}: {
  onCancel: () => void;
  pending?: boolean;
  saveLabel?: string;
}) {
  const docked = useDockedFormCta();
  const report = docked?.report;

  // `onCancel` est recréé à chaque rendu par presque tous les appelants. Le
  // mettre dans les dépendances ferait : annoncer → le pied change d'état →
  // le formulaire se re-rend → nouvelle identité → annoncer… une boucle.
  // D'où un geste d'annulation d'identité STABLE qui lit toujours le dernier,
  // et des dépendances réduites aux deux valeurs qui changent l'affichage.
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });
  const stableCancel = useCallback(() => cancelRef.current(), []);

  useEffect(() => {
    if (!report) return;
    report({ saveLabel, pending: Boolean(pending), onCancel: stableCancel });
  }, [report, saveLabel, pending, stableCancel]);

  // Le retrait ne se fait qu'au DÉMONTAGE : un nettoyage à chaque changement
  // de valeur ferait clignoter le pied.
  useEffect(() => {
    if (!report) return;
    return () => report(null);
  }, [report]);

  if (docked) return null;

  return (
    <div className="flex justify-end gap-2 mt-[18px]">
      <button
        type="button"
        onClick={onCancel}
        className="h-[34px] px-3.5 rounded-[9px] cursor-pointer bg-paper border border-rule text-medium-14 text-ink-2 hover:bg-hover hover:border-rule-2 transition-colors"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={pending}
        className="h-[34px] px-4 rounded-[9px] border-0 cursor-pointer bg-ink text-canvas text-medium-14 hover:brightness-90 disabled:opacity-50 transition-[filter,opacity]"
      >
        {pending ? 'Saving…' : saveLabel}
      </button>
    </div>
  );
}
