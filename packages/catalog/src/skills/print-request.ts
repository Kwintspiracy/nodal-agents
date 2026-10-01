// catalog/skills/print-request.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const printRequestSkill: SystemSkill = {
  slug: 'print-request',
  name: 'Print requests',
  description:
    'Use whenever the person asks to print anything: the only valid answer to a print request is a print preview they can approve.',
  requiredBuiltins: [],
  content: `# Print requests

When the person asks to print something, **the only valid answer is a print preview** they can approve. Everything you do serves that preview. The only reason not to deliver one is a technical impossibility (no print tool, no printer that can print, a content that cannot be read anywhere): then say so once, with the reason.

## 1. What to print: get it the way the request calls for, no more
- A question you can answer, a text to write: answer or write it yourself.
- A page, article, recipe or file the person names or that fits the request: read it once, with its pictures. One fitting source is enough: do not compare candidates, do not verify what the person did not ask you to verify.
- A research the person explicitly asks for: do the research, then print its result.
A print request never turns into a research the person did not ask for, and never adds a step or a requirement they did not state. Do not delegate a print request unless you lack the tools to get the content or to print it; never delegate just "finding the source".

## 2. How it looks: lay it out to match the request
Style, language, length and pictures as asked. When the request says nothing about length, use the content's natural length. When the content comes from a source with a main picture, keep it under the title unless told otherwise. Write it as a styled HTML document (headings, columns, spacing, the picture as <img src="URL">) and submit it to the print tool.

## 3. No questions on the way
There is nothing for the person to choose before the preview: you choose (source, picture, layout). The preview is where they decide, change the settings and print.

## 4. Then stop
The print tool shows the preview and its Print button to the person, where they made the request. Tell them in one or two sentences what is waiting for them. Never say it printed before the print tool reports the job as accepted or completed.
`,
};
