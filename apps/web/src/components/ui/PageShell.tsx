import type { ReactNode } from 'react';
import PageHeader from './PageHeader';

type Common = {
  /** Optional toolbar row (filters/tabs + search + the page's create CTA),
   *  rendered just below the header. Build it with `PageTopBar`. The create
   *  button lives HERE, never in the navbar. */
  toolbar?: ReactNode;
  /**
   * La barre du `toolbar` porte SES propres gouttières et va d'un bord à
   * l'autre (#135). C'est ce qu'il faut pour la `WorkBar` d'un fil : la
   * maquette lui donne un fond et deux filets pleine largeur, que l'enveloppe
   * à gouttières du `toolbar` coupait de chaque côté. Un drapeau plutôt qu'un
   * créneau de plus : les trois écrans de fil passent déjà par `toolbar`.
   *
   * Vaut aussi pour un écran qui DÉFILE normalement (#202) : la page d'une
   * automatisation porte la même `WorkBar` que les écrans de fil, et une barre
   * du design system ne peut pas se dessiner autrement d'un écran à l'autre.
   * La barre sort alors de l'enveloppe à gouttières du corps et se pose juste
   * sous l'en-tête, d'un bord à l'autre ; le corps garde les siennes.
   */
  toolbarBleed?: boolean;
  /**
   * Un panneau ANCRÉ au bord droit, hors de la colonne de contenu et sous
   * l'en-tête (#237). Il POUSSE la page au lieu de la couvrir : c'est ce qui
   * le distingue d'un `Drawer`, et ce qui oblige à le poser ici plutôt que
   * dans `children` — depuis le corps, il ne pourrait pas sortir de la borne
   * de largeur ni prendre la hauteur pleine.
   *
   * N'a d'effet que sur un écran `fill` : un écran qui défile avec le document
   * n'a pas de hauteur à donner à un panneau ancré.
   */
  aside?: ReactNode;
  /** Page body. */
  children: ReactNode;
  /** Drop the max-width body wrapper (full-bleed body — e.g. full-screen chat). */
  fluid?: boolean;
  /** Extra classes on the body wrapper. */
  bodyClassName?: string;
  /**
   * Un écran qui REMPLIT la hauteur au lieu de défiler avec le document : le
   * corps devient une colonne de hauteur pleine, et c'est l'enfant qui décide
   * ce qui défile. C'est ce qu'il faut pour un fil de conversation — la saisie
   * reste en bas de l'ÉCRAN, qu'il y ait deux lignes ou deux cents (Quentin,
   * 07/09 : « le champ de texte est en plein milieu »). Les pages de liste
   * n'en veulent pas : elles défilent normalement.
   */
  fill?: boolean;
};

type Props =
  | (Common & {
      /** Page title — shown as the h1 in the full-width header. */
      title: ReactNode;
      /** One-line lede under the title. Keep it to a single short sentence. */
      subtitle?: ReactNode;
      header?: undefined;
    })
  | (Common & {
      /**
       * A header of the page's own making, in a compact 75px bar, INSTEAD of
       * the display title and its lede (P2bis). The thread screens use it: a
       * work header is a row of facts (name, path, who worked, verdict), not a
       * title. The global controls stay. Mutually exclusive with `title`.
       */
      header: ReactNode;
      title?: undefined;
      subtitle?: undefined;
    });

/**
 * PageShell — THE single layout wrapper every dashboard page uses. There is no
 * per-page header markup anywhere else: a page renders exactly one `<PageShell>`
 * and everything below the header goes in `children`. This guarantees every
 * screen shares the identical full-width header (title + lede + search +
 * notifications + theme) and the same bottom rule — change the look once here
 * and the whole product tracks.
 *
 * The navbar carries NO create button (per the design). A page's "+ New …" CTA
 * goes in the `toolbar` (right side), or in the body. The body is LEFT-aligned
 * (max-width, no auto-centering).
 *
 * Structure:
 *   ┌──────────────────────────────────────────────┐
 *   │ PageHeader (full-width, bottom rule)          │  ← title · global controls
 *   ├──────────────────────────────────────────────┤
 *   │ body (max-w-6xl, left):  [toolbar] + children │  ← filters/CTA, then content
 *   └──────────────────────────────────────────────┘
 */
export default function PageShell(props: Props) {
  const {
    toolbar,
    toolbarBleed = false,
    aside,
    children,
    fluid = false,
    fill = false,
    bodyClassName = '',
  } = props;
  const head =
    props.header !== undefined ? (
      <PageHeader header={props.header} />
    ) : (
      <PageHeader title={props.title} subtitle={props.subtitle} />
    );
  if (fill) {
    // L'en-tête ne défile pas, le corps prend le reste de la hauteur, et
    // l'enfant place lui-même ce qui défile et ce qui reste ancré.
    //
    // #237 — la colonne de CONTENU porte la même borne de largeur qu'en mode
    // ordinaire (`max-w-6xl`), et le panneau `aside` vit EN DEHORS d'elle,
    // collé au bord droit. Sans cette borne, un écran pleine hauteur étalait
    // son contenu sur toute la largeur pendant que la page d'à côté le bornait
    // — deux largeurs de lecture dans la même application. `fluid` la retire
    // pour les écrans qui remplissent vraiment le cadre : un fil de chat, la
    // page d'un run, la page d'un projet.
    return (
      <div className="flex h-full min-h-0 flex-col">
        {head}
        {toolbar && toolbarBleed && toolbar}
        {/* La rangée : le contenu à gauche, le panneau ancré à droite. Elle
            existe même sans panneau, pour que la géométrie ne change pas selon
            qu'il est ouvert ou fermé. */}
        <div className="flex min-h-0 flex-1">
          <div className={`flex min-w-0 min-h-0 flex-1 flex-col ${bodyClassName}`}>
            {toolbar && !toolbarBleed && (
              <div className={`px-5 pt-4 sm:px-8 lg:px-9 ${fluid ? '' : 'max-w-6xl'}`}>
                {toolbar}
              </div>
            )}
            {fluid ? (
              children
            ) : (
              <div className="flex min-h-0 w-full max-w-6xl flex-1 flex-col">{children}</div>
            )}
          </div>
          {aside}
        </div>
      </div>
    );
  }
  return (
    <>
      {head}
      {/* Une barre « bleed » se pose HORS du corps : elle porte ses propres
          gouttières et va d'un bord à l'autre, comme sous l'en-tête d'un fil. */}
      {toolbar && toolbarBleed && toolbar}
      <div
        className={`px-5 pt-6 pb-10 sm:px-8 lg:px-9 ${fluid ? '' : 'max-w-6xl'} ${bodyClassName}`}
      >
        {toolbar && !toolbarBleed && <div className="mb-5">{toolbar}</div>}
        {children}
      </div>
    </>
  );
}
