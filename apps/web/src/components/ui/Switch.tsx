'use client';

type Size = 'sm' | 'md';

type Props = {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** `sm` = 20×36px (LearnedSkillsClient's Agent-learning toggle). `md` = 22×38px
   *  (AgentComposer's Yolo / script / file-write toggles). Both geometries were
   *  already live in the app — Switch doesn't force them to converge. */
  size?: Size;
  /** Full class string for the track (background + border colour) for the
   *  CURRENT state — computed by the caller (off / on / dormant, whatever
   *  states it has). Switch owns only the shared geometry and aria wiring. */
  trackClassName: string;
  /** Full class string for the thumb (colour + translate-x position). */
  thumbClassName: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  /**
   * L'IMAGE d'un interrupteur, pas un interrupteur : rend un `<span>` inerte
   * et invisible aux lecteurs d'écran, au lieu du bouton.
   *
   * Pourquoi (#231) : la liste des réglages montre l'état de deux réglages sur
   * la ligne, et RIEN ne se modifie depuis la liste — le geste vit dans le
   * panneau, avec sa confirmation. Un bouton qu'on ne peut pas actionner est un
   * mensonge, et un bouton imbriqué dans la ligne cliquable est un HTML
   * invalide. La valeur reste écrite en toutes lettres à côté (« Released »,
   * « Closed to external clients »), donc rien n'est perdu au clavier ni à la
   * voix. `onChange` n'est jamais appelé dans ce mode.
   */
  readOnly?: boolean;
};

const TRACK_DIM: Record<Size, string> = {
  sm: 'h-5 w-9 border-2 border-transparent',
  md: 'h-[22px] w-[38px] border',
};
const THUMB_DIM: Record<Size, string> = {
  sm: 'h-4 w-4 shadow-lg',
  md: 'h-[16px] w-[16px] shadow-sm',
};

/**
 * Switch — the `role="switch"` on/off toggle, used for the Agent-learning
 * toggle (LearnedSkillsClient), and Yolo mode / community-skill script &
 * file-write authorization (AgentComposer's Autonomy tab). Two colour
 * languages coexist (solid-fill + white thumb vs tinted-track + coloured
 * thumb, the latter with a "dormant" third state for Yolo) — rather than
 * force a redesign, Switch owns only geometry/transition/disabled/aria and
 * takes the full track/thumb class strings from the caller.
 */
export default function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  trackClassName,
  thumbClassName,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  readOnly = false,
}: Props) {
  const thumb = (
    <span
      className={`pointer-events-none inline-block rounded-full transition-transform duration-200 ${THUMB_DIM[size]} ${thumbClassName}`}
    />
  );

  if (readOnly) {
    return (
      <span
        aria-hidden="true"
        data-state={checked ? 'on' : 'off'}
        className={`relative inline-flex shrink-0 items-center rounded-full ${TRACK_DIM[size]} ${trackClassName}`}
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
      className={`relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${TRACK_DIM[size]} ${trackClassName}`}
    >
      {thumb}
    </button>
  );
}
