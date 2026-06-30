import type { ReactNode } from 'react';
import PageHeader from './PageHeader';

type Props = {
  /** Page title — shown as the h1 in the full-width header. */
  title: ReactNode;
  /** One-line lede under the title. Keep it to a single short sentence. */
  subtitle?: ReactNode;
  /** Optional toolbar row (filters/tabs + search + the page's create CTA),
   *  rendered just below the header. Build it with `PageTopBar`. The create
   *  button lives HERE, never in the navbar. */
  toolbar?: ReactNode;
  /** Page body. */
  children: ReactNode;
  /** Drop the max-width body wrapper (full-bleed body — e.g. full-screen chat). */
  fluid?: boolean;
  /** Extra classes on the body wrapper. */
  bodyClassName?: string;
};

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
export default function PageShell({
  title,
  subtitle,
  toolbar,
  children,
  fluid = false,
  bodyClassName = '',
}: Props) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <div
        className={`px-5 pt-6 pb-10 sm:px-8 lg:px-9 ${fluid ? '' : 'max-w-6xl'} ${bodyClassName}`}
      >
        {toolbar && <div className="mb-5">{toolbar}</div>}
        {children}
      </div>
    </>
  );
}
