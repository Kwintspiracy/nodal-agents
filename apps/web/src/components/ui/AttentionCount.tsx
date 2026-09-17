// AttentionCount — la pastille qui compte ce qui ATTEND LA PERSONNE (#135).
//
// Extraite du rendu `pill` de `SidebarLink`, où elle vivait en dur : les
// dossiers du menu Chat en portent une chacun, et la barre latérale en portait
// déjà une sur « Approvals ». Deux copies auraient divergé au premier
// ajustement.
//
// Elle ne s'affiche JAMAIS à zéro — c'est l'appelant qui ne la rend pas. Une
// pastille « 0 » demande d'être lue pour apprendre qu'il n'y a rien à faire.

type Props = {
  /** Le nombre. L'appelant ne rend pas le composant à zéro. */
  count: number;
  /**
   * Le plafond au-delà duquel on écrit « N+ ». 9 dans les dossiers du menu
   * Chat, où la place est comptée ; 99 sur « Approvals », qui l'affichait
   * ainsi avant cette extraction et dont les parcours e2e lisent le texte.
   */
  max?: number;
  /**
   * `tint` — le fond corail translucide, texte corail : ce que porte
   * « Approvals » depuis toujours, et ce qui ne doit pas changer.
   * `solid` — le corail plein, texte papier : ce que la maquette dessine sur
   * un dossier, où la pastille doit se voir sur une ligne déjà chargée.
   */
  variant?: 'tint' | 'solid';
  className?: string;
};

const STYLE: Record<'tint' | 'solid', string> = {
  tint: 'bg-err/12 px-2 py-0.5 text-medium-13 text-err lg:px-1.5 lg:py-0 lg:text-micro-11',
  solid: 'bg-err px-1.5 py-px text-micro-10 text-paper',
};

export default function AttentionCount({
  count,
  max = 99,
  variant = 'tint',
  className = '',
}: Props) {
  return (
    <span className={`shrink-0 rounded-full ${STYLE[variant]} ${className}`}>
      {count > max ? `${max}+` : count}
    </span>
  );
}
