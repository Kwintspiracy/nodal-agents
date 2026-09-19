'use client';

/**
 * SettingsPanel — le panneau ancré de /settings (planche P1, #231).
 *
 * Il vit à part de la liste parce que `PageShell` les pose de part et d'autre
 * de la borne de largeur : la liste dans la colonne de contenu, bornée comme
 * sur toutes les pages, et lui dans l'`aside`, collé au bord de l'écran. Ce
 * qu'ils partagent passe par `SettingsScreen`.
 *
 * Cancel et Save vivent ici, au bas du panneau, et soumettent le formulaire
 * ouvert par l'attribut HTML `form` — voir `DockedFormCta.tsx`. Un panneau n'a
 * donc un pied que si son formulaire a des actions : les sections à
 * interrupteur immédiat et les panneaux en lecture seule n'en ont pas, sans
 * qu'une liste le répète quelque part où elle se périmerait.
 */

import type { ReactNode } from 'react';
import DockedPanel from '@/components/ui/DockedPanel';
import { DockedFormCtaProvider } from '@/components/ui/DockedFormCta.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { dockedFormId } from '@/lib/docked-form-id.ts';
import { useSettingsScreen } from './SettingsScreen.tsx';
import type { SettingId } from './settings-rows.ts';

type Props = {
  /** Le contenu du panneau, par réglage — les formulaires existants, tels quels. */
  panels: Partial<Record<SettingId, ReactNode>>;
};

export default function SettingsPanel({ panels }: Props) {
  const { openRow, setOpen, cta, report, cancel } = useSettingsScreen();
  const panel = openRow === null ? null : (panels[openRow.id] ?? null);

  return (
    <DockedPanel
      open={openRow !== null}
      onClose={() => setOpen(null)}
      title={openRow?.name ?? ''}
      testId="settings-panel"
      footer={
        openRow !== null && cta !== null ? (
          <>
            <PrimaryButton
              variant="neutral"
              type="button"
              data-testid="settings-panel-cancel"
              onClick={() => {
                // Le formulaire remet son état, puis le panneau se ferme.
                cancel();
                setOpen(null);
              }}
            >
              Cancel
            </PrimaryButton>
            <PrimaryButton
              variant="ink"
              type="submit"
              form={dockedFormId(openRow.id)}
              disabled={cta.pending}
              data-testid="settings-panel-save"
            >
              {cta.pending ? 'Saving…' : cta.saveLabel}
            </PrimaryButton>
          </>
        ) : undefined
      }
    >
      {openRow !== null && <p className="text-body-13 text-ink-3">{openRow.lede}</p>}
      {/* Un panneau vide est un cul-de-sac : quand la lecture du réglage a
          échoué, la page n'a aucun formulaire à mettre ici, et le panneau dit
          pourquoi au lieu de ne rien dire (invariant #4). */}
      {openRow !== null && panel === null ? (
        <p className="text-body-13 text-warn" data-testid="settings-panel-unread">
          {openRow.value}. Reload the page, and check the runner is up.
        </p>
      ) : (
        openRow !== null && (
          <DockedFormCtaProvider
            key={openRow.id}
            value={{ formId: dockedFormId(openRow.id), report }}
          >
            {panel}
          </DockedFormCtaProvider>
        )
      )}
    </DockedPanel>
  );
}
