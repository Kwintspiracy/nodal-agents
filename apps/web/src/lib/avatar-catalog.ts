// avatar-catalog.ts — static catalog of bundled agent avatars.
//
// Source files live at `apps/web/public/avatars/avatar-{01..42}.png` and
// are served by Next.js's static handler at `/avatars/avatar-XX.png`.
// The DB column `agents.avatar_url` stores the path (`/avatars/avatar-07.png`),
// not the catalog id — that way display code is just `<img src={agent.avatarUrl}>`
// with no lookup roundtrip.
//
// The catalog is hardcoded (no fs.readdir at boot) so it stays pure for SSR
// and the picker can render without any I/O. Adding a new avatar = drop the
// PNG in `public/avatars/` + add one line here.

export interface AvatarEntry {
  id: string;
  url: string;
}

/** Total number of bundled avatars. Drives the picker grid layout. */
const AVATAR_COUNT = 42;

/**
 * The full set of selectable avatars. Order matters — it's the order shown
 * in the picker grid (6 cols × 7 rows).
 */
export const AVATAR_CATALOG: AvatarEntry[] = Array.from({ length: AVATAR_COUNT }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { id: `avatar-${n}`, url: `/avatars/avatar-${n}.png` };
});

/**
 * Server-action allowlist: validates an avatarUrl payload before persisting
 * it on `agents.avatar_url`. Anti-XSS guard — without this we'd accept any
 * URL the user (or a malicious payload) shoves into the form.
 *
 * Accepts:
 *   - null (clear the avatar)
 *   - a path matching `/avatars/avatar-NN.png` where NN is in the catalog
 *
 * Anything else (external https URL, traversal, fake filename) rejects.
 */
export function isValidAvatarUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return true;
  if (typeof url !== 'string') return false;
  return AVATAR_CATALOG.some((a) => a.url === url);
}
