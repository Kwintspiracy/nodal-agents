/**
 * copyText — the ONE way the dashboard writes to the clipboard.
 *
 * `navigator.clipboard` only exists in a secure context (https, or localhost).
 * The dashboard is also served over plain http on a LAN IP (bind=lan), and
 * there `navigator.clipboard` is `undefined`: every Copy button failed with a
 * red "Could not copy" (the run id on /runs, 28/09/2026). Only `SetUrl` had a
 * fallback, so a copy worked or not depending on which component drew the
 * button. They all go through here now.
 *
 * The API is tried first. When it is missing or refuses (no permission, the
 * document is not focused), the text is copied through a hidden textarea and
 * `document.execCommand('copy')`, which browsers still honour inside a click.
 * Throws when both fail, so the caller says so instead of pretending.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // refused: the textarea path below may still work
    }
  }
  copyThroughTextarea(text);
}

function copyThroughTextarea(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  const previousFocus = document.activeElement;
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    if (!document.execCommand('copy')) throw new Error('copy_failed');
  } finally {
    ta.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}
