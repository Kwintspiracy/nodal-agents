// runner-images.mjs — find the moving runner labels in a workflow file (issue #882).
//
// `ubuntu-latest`, `windows-latest` and `macos-latest` follow an image GitHub
// switches without notice. On 2026-10-30 `ubuntu-latest` became Ubuntu 26.04
// and Playwright 1.60 refused to install Chromium there: every PR went red on a
// day nothing in the repository had changed. A workflow names its image.
//
// Any `<os>-latest` token outside a comment counts, not only the value of
// `runs-on:`: a `matrix.os` list feeding `runs-on: ${{ matrix.os }}` moves just
// the same.

const MOVING_LABEL = /\b(?:ubuntu|windows|macos)-latest\b/g;

/** The part of a YAML line that is not a comment. */
function codePart(line) {
  const hash = line.search(/(^|\s)#/);
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Every moving label in `text`, with its 1-based line number.
 * @param {string} text
 * @returns {{ line: number, label: string }[]}
 */
export function findMovingLabels(text) {
  const found = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    for (const m of codePart(raw).matchAll(MOVING_LABEL)) {
      found.push({ line: i + 1, label: m[0] });
    }
  });
  return found;
}
