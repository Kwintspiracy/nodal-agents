// lib/launch-page.ts — what a browser that has not been let in sees.
//
// In the mode with no password, the dashboard is entered through a launch link
// that a program on this computer makes from the install's secret
// (`nodal-agents up`, `nodal-agents open`). A browser without the cookie that
// link leaves (another profile, a bookmark opened before `up`, a used or
// expired link) gets THIS page, on every path the proxy refuses: never a blank
// error. It says how to get the link again.
//
// It is answered by the proxy itself, before Next renders anything, so it is
// one self-contained document: no script of the app, no stylesheet, no font.

import type { LaunchRefusal } from '@nodal-agents/auth';

/** Why this browser is shown the page. */
export type LaunchPageReason = 'proof_required' | 'proof_invalid' | LaunchRefusal | 'launch_used';

const DETAIL: Record<LaunchPageReason, string | null> = {
  proof_required: null,
  proof_invalid: 'This browser holds an entry that is not from this Nodal.',
  launch_malformed: 'This link is incomplete. Copy it again in full.',
  launch_invalid: 'This link was not made by this Nodal.',
  launch_expired: 'This link has expired.',
  launch_used: 'This link was already used.',
};

export interface LaunchPageOptions {
  reason: LaunchPageReason;
  /**
   * The browser arrived from another site (a sign-in provider sending it back,
   * a link clicked elsewhere). The cookie is `SameSite=Strict`, so the browser
   * held it back on that one navigation: the page opens the same address once
   * more from here, where the browser sends it.
   */
  retryFromHere: boolean;
}

export function launchPageHtml({ reason, retryFromHere }: LaunchPageOptions): string {
  const detail = DETAIL[reason];
  // A navigation started by this document is a same-origin one, and the
  // proxy never asks for a retry on those: it happens once, never in a loop.
  const retry = retryFromHere ? '<script>location.replace(location.href)</script>\n' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Open Nodal</title>
${retry}<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--muted:#5f5f5a;--line:#e2e2dd;--code:#f0f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ececea;--muted:#a3a39d;--line:#33332f;--code:#2a2a27}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{max-width:480px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}
p{margin:0 0 12px;color:var(--muted)}
p.detail{color:var(--fg)}
code{display:block;font:15px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);border-radius:8px;padding:10px 12px;margin:0 0 12px;overflow-x:auto}
</style>
</head>
<body>
<main data-reason="${reason}">
<h1>Open Nodal from this computer</h1>
${detail ? `<p class="detail">${detail}</p>\n` : ''}<p>Nodal opens only through a link made on the computer it runs on. In a terminal there, run:</p>
<code>nodal-agents open</code>
<p>It opens the dashboard in your browser, or prints a link to paste here. A link works once, within 10 minutes. After that, this browser stays in.</p>
</main>
</body>
</html>
`;
}
