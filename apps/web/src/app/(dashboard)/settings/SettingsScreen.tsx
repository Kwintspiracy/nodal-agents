'use client';

/**
 * SettingsScreen — l'état que la LISTE et le PANNEAU partagent (#231, #237).
 *
 * Pourquoi un contexte plutôt qu'un seul composant : la colonne de contenu
 * d'une page est bornée en largeur, comme sur toutes les pages, et un panneau
 * ancré doit rester collé au bord de l'écran. Les deux ne peuvent donc pas
 * vivre dans la même boîte — `PageShell` pose la liste dans `children` et le
 * panneau dans `aside`, de part et d'autre de la borne. Ce qu'ils ont en
 * commun — quel réglage est ouvert, et ce que son formulaire dit de ses
 * actions — passe par ici.
 *
 * L'URL suit le réglage ouvert (`/settings?open=network`) pour qu'un lien
 * direct ouvre le panneau. La page serveur lit `?open` au premier rendu ; les
 * clics suivants réécrivent l'URL sans repasser par le serveur, sinon chaque
 * ligne cliquée rechargerait les onze lectures.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DockedFormCta } from '@/components/ui/DockedFormCta.tsx';
import type { SettingId, SettingRow } from './settings-rows.ts';

type Value = {
  rows: SettingRow[];
  /** Le réglage ouvert, ou `null`. */
  open: SettingId | null;
  setOpen: (id: SettingId | null) => void;
  /** La ligne ouverte, déjà retrouvée. */
  openRow: SettingRow | null;
  /** Ce que le formulaire ouvert a annoncé de ses actions. `null` ⇒ pas de pied. */
  cta: { saveLabel: string; pending: boolean } | null;
  report: (cta: DockedFormCta | null) => void;
  /** Le geste d'annulation du formulaire ouvert, s'il en a un. */
  cancel: () => void;
};

const Context = createContext<Value | null>(null);

export function useSettingsScreen(): Value {
  const v = useContext(Context);
  if (v === null) throw new Error('hors de SettingsScreenProvider');
  return v;
}

export function SettingsScreenProvider({
  rows,
  initialOpen,
  children,
}: {
  rows: SettingRow[];
  initialOpen: SettingId | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<SettingId | null>(initialOpen);

  // Le geste d'annulation vit dans une ref : il ne change rien à l'affichage,
  // et le garder dans l'état ferait re-rendre le pied pour rien.
  const [cta, setCta] = useState<Value['cta']>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const report = useCallback((next: DockedFormCta | null) => {
    cancelRef.current = next ? next.onCancel : null;
    setCta((prev) => {
      if (next === null) return null;
      if (prev && prev.saveLabel === next.saveLabel && prev.pending === next.pending) return prev;
      return { saveLabel: next.saveLabel, pending: next.pending };
    });
  }, []);
  const cancel = useCallback(() => cancelRef.current?.(), []);

  // L'URL suit le panneau, sans repasser par le serveur.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (open === null) url.searchParams.delete('open');
    else url.searchParams.set('open', open);
    window.history.replaceState(null, '', url.toString());
  }, [open]);

  const value = useMemo<Value>(
    () => ({
      rows,
      open,
      setOpen,
      openRow: open === null ? null : (rows.find((r) => r.id === open) ?? null),
      cta,
      report,
      cancel,
    }),
    [rows, open, cta, report, cancel],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
