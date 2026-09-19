'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** Ce qu'un formulaire dit de ses actions au pied qui va les porter. */
export type DockedFormCta = {
  /** Le libellé du bouton d'enregistrement — « Save », « Create »… */
  saveLabel: string;
  /** Vrai pendant l'enregistrement : le pied grise son bouton et le dit. */
  pending: boolean;
  /** Ce que le formulaire fait quand on renonce — il remet son état. */
  onCancel: () => void;
};

type Value = {
  /** L'`id` du `<form>` que le bouton du pied soumet (attribut HTML `form`). */
  formId: string;
  /** Appelé par `SetCtaRow` : ses actions, ou `null` quand il s'en va. */
  report: (cta: DockedFormCta | null) => void;
};

const Context = createContext<Value | null>(null);

/**
 * DockedFormCta — comment les actions d'un formulaire montent dans le pied du
 * panneau ancré (planche P1, #231).
 *
 * Le problème : la planche dessine Cancel et Save au BAS du panneau, alors que
 * les dix formulaires de réglages portent chacun les leurs au bout de leur
 * propre corps, via `SetCtaRow`. Les réécrire pour sortir leur soumission
 * serait dix refontes pour un déplacement visuel.
 *
 * Ce qui se passe à la place, et qui ne touche à la logique d'aucun d'eux :
 *   - le formulaire garde son `<form onSubmit>`, sa validation, son action
 *     serveur ; il reçoit seulement un `formId` qu'il pose sur son `<form>` ;
 *   - le bouton du pied est un `type="submit"` avec l'attribut HTML `form`
 *     qui pointe cet `id`. Le navigateur soumet le formulaire exactement comme
 *     si le bouton était dedans — validation comprise — sans qu'il ait à
 *     l'être dans le DOM ;
 *   - `SetCtaRow`, lui, se rend INVISIBLE quand il est dans un panneau et
 *     ANNONCE ce qu'il aurait affiché : son libellé, son état d'attente, son
 *     geste d'annulation. Le pied les rend.
 *
 * Conséquence voulue : un panneau n'a un pied que si son formulaire a des
 * actions. Les sections à interrupteur immédiat (frein d'auto-exécution,
 * serveur MCP, surfaces de vérification) et les panneaux en lecture seule
 * n'ont pas de `SetCtaRow`, donc pas de pied — sans qu'une liste le répète
 * quelque part, où elle se périmerait.
 */
export function DockedFormCtaProvider({ value, children }: { value: Value; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** `null` hors d'un panneau ancré — et alors `SetCtaRow` s'affiche comme avant. */
export function useDockedFormCta(): Value | null {
  return useContext(Context);
}

/** L'`id` du `<form>` d'un réglage. Une seule source, des deux côtés. */
export function dockedFormId(settingId: string): string {
  return `settings-form-${settingId}`;
}
