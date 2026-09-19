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
  /**
   * L'IMAGE d'un interrupteur, pas un interrupteur : rend un `<span role="img">`
   * inerte au lieu du bouton.
   *
   * Vient de la PR #237 (la page Settings en liste, issue #231) : la liste
   * montre l'état de deux réglages sur la ligne, et RIEN ne se modifie depuis
   * la liste — le geste vit dans le panneau, avec sa confirmation. Un bouton
   * qu'on ne peut pas actionner est un mensonge, et un bouton imbriqué dans la
   * ligne cliquable est un HTML invalide. `onChange` n'est jamais appelé dans
   * ce mode.
   *
   * L'image se nomme elle-même : `role="img"` et un `aria-label` — celui de
   * l'appelant, sinon « On » / « Off ». Elle a d'abord été posée `aria-hidden`,
   * au motif que la ligne annonçait l'état à côté ; c'était faux dans cet
   * arbre, où aucun appelant ne passe encore `readOnly` (Reviewer C, passe 2).
   * Une image muette qui compte sur un voisin qui n'existe pas n'annonce rien.
   *
   * Elle porte exactement les couleurs de l'état qu'elle montre, `disabled`
   * compris : une image qui ne ressemblerait pas au contrôle ne servirait à
   * rien. Elle n'a en revanche ni curseur, ni anneau de focus, ni transition —
   * il n'y a rien à actionner, et rien qui bouge.
   */
  readOnly?: boolean;
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
 * `readOnly` rend l'IMAGE de l'un de ces états sans le contrôle — voir sa
 * propre note. C'est le seul rendu qui ne soit pas un bouton, et il ne change
 * aucune couleur.
 *
 * Les quatorze appels passent `checked`, `onChange`, `disabled`, `size`,
 * `readOnly` et l'aria. Aucune couleur, aucune classe : ce qui doit se dire se dit
 * À CÔTÉ de l'interrupteur, avec un `MonoMicroTag` ou une phrase, jamais en le
 * teintant (c'est ce que faisait l'état « dormant » de Yolo jusqu'au
 * 19/09/2026). `apps/web/src/tests/one-switch.arch.test.ts` refuse tout autre
 * dessin d'interrupteur dans `apps/web/src`.
 */
export default function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  readOnly = false,
}: Props) {
  // Une seule expression de couleur pour les deux rendus : l'image et le
  // contrôle ne peuvent pas diverger (#236 + #237).
  const track = `relative inline-flex shrink-0 items-center rounded-full ${TRACK_DIM[size]} ${checked ? 'bg-ok' : 'bg-ink-4'}`;
  const thumb = (
    <span
      className={`pointer-events-none inline-block rounded-full bg-paper ${readOnly ? '' : 'transition-transform duration-200'} ${THUMB_DIM[size]} ${checked ? 'translate-x-[19px]' : 'translate-x-[3px]'}`}
    />
  );

  if (readOnly) {
    return (
      <span
        role="img"
        aria-label={ariaLabel ?? (checked ? 'On' : 'Off')}
        data-state={checked ? 'on' : 'off'}
        className={`${track} ${disabled ? 'opacity-50' : ''}`}
      >
        {thumb}
      </span>
    );
  }

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
      className={`${track} cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-conn-vivid/50 disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {thumb}
    </button>
  );
}
