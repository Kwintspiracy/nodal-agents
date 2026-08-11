/**
 * SetBlock — wraps a settings section.
 * Renders a mono uppercase label, optional lede description, and children.
 * Handles all spacing so callers don't repeat margins.
 *
 * The label is an `<h2>`, not a styled `<div>`. It was a div until 2026-08-11,
 * which cost the settings page its document outline entirely — a screen-reader
 * user landed on `/settings` and found one `<h1>` and no way to jump between
 * Network, Security, Timezone or Workspaces. Nothing in the design changes:
 * `<section>` already carried the grouping, and the reset zeroes the browser's
 * default heading margins, so the four classes below are the whole appearance.
 *
 * Found by replaying the Playwright suite, which had been looking for
 * `heading level 2` here since before the redesign and failing silently in a
 * job nobody ran.
 */
export function SetBlock({
  label,
  lede,
  children,
}: {
  label: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-7">
      <h2 className="text-mono-11 tracking-[0.18em] uppercase text-ink-4">{label}</h2>
      {lede && <p className="text-body-14 leading-[1.5]! text-ink-3 mt-1.5">{lede}</p>}
      {children}
    </section>
  );
}
