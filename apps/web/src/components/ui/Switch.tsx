'use client';

type Size = 'sm' | 'md';

type Props = {
  checked: boolean;
  onChange: () => void;
  /** Le SEUL état qui a le droit d'avoir l'air désactivé (opacité 50%). */
  disabled?: boolean;
  /** `sm` = 20×36px, `md` = 22×38px — les deux tailles de la planche. */
  size?: Size;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
};

/** Piste : 36×20 en `sm`, 38×22 en `md` (planche Figma `Switch`, node 108:18). */
const TRACK_DIM: Record<Size, string> = {
  sm: 'h-5 w-9',
  md: 'h-[22px] w-[38px]',
};

/** Bouton : Ø14 en `sm`, Ø16 en `md`. Il part à 3px du bord dans les deux cas. */
const THUMB_DIM: Record<Size, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
};

/**
 * Switch — l'interrupteur on/off `role="switch"` du produit, et la SEULE
 * source de son apparence.
 *
 * Issue #236 (constat de Quentin sur la stack, 19/09/2026) : le toggle du
 * serveur MCP avait l'air désactivé alors qu'il était allumé. La cause tenait
 * à ce composant : il ne portait que la géométrie et l'aria, et chaque
 * appelant passait ses propres classes de piste et de bouton. Deux langages de
 * couleur coexistaient — piste pleine + bouton blanc ici, piste teintée
 * (`bg-agent/20`) + bouton coloré là — et le second se lit comme un contrôle
 * éteint à côté du premier.
 *
 * Il n'y a donc plus qu'un seul mode, celui de la planche Figma `Switch`
 * (fichier `GWXBALe90DMFR3XYGccofJ`, node `108:18`, états Off / On / Focus /
 * Disabled × tailles sm / md) :
 *
 * - Off : piste `ink-4`, bouton `paper` à gauche.
 * - On : piste `ok`, bouton `paper` à droite. Allumé est allumé, sans nuance.
 * - Focus : anneau `conn-vivid` à 50%, 3px, sans décalage (le `feMorphology
 *   radius=3` de la planche).
 * - Disabled : le même dessin à 50% d'opacité. C'est le seul état atténué.
 *
 * Les appelants passent `checked`, `onChange`, `disabled`, `size` et l'aria.
 * Aucune couleur, aucune classe : une nuance qui doit se dire se dit À CÔTÉ de
 * l'interrupteur, avec un `MonoMicroTag` ou une phrase, jamais en le teintant
 * (c'est ce que faisait l'état « dormant » de Yolo jusqu'au 19/09/2026).
 * `apps/web/src/tests/one-switch.arch.test.ts` refuse tout autre dessin
 * d'interrupteur dans `apps/web/src`.
 */
export default function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-conn-vivid/50 disabled:cursor-not-allowed disabled:opacity-50 ${TRACK_DIM[size]} ${checked ? 'bg-ok' : 'bg-ink-4'}`}
    >
      <span
        className={`pointer-events-none inline-block rounded-full bg-paper transition-transform duration-200 ${THUMB_DIM[size]} ${checked ? 'translate-x-[19px]' : 'translate-x-[3px]'}`}
      />
    </button>
  );
}
