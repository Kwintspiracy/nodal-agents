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
    'Use whenever the person asks to print anything. The only valid answer to a print request is a print preview they can approve: get the content and lay it out YOURSELF with your own tools, then call the print tool. Do not delegate it, do not ask questions on the way. Check the print tool report and fix the page before handing it over.',
  requiredBuiltins: [],
  content: `# Print requests

When the person asks to print something, **the only valid answer is a print preview** they can approve. Everything you do serves that preview. The only reason not to deliver one is a technical impossibility (no print tool, no printer that can print, a content that cannot be read anywhere): then say so once, with the reason.

## 1. What to print: get it the way the request calls for, no more
- A question you can answer, a text to write: answer or write it yourself.
- A page, article, recipe or file the person names or that fits the request: read it once, with its pictures. One fitting source is enough: do not compare candidates, do not verify what the person did not ask you to verify.
- A research the person explicitly asks for: do the research, then print its result.
A print request never turns into a research the person did not ask for, and never adds a step or a requirement they did not state. Do not delegate a print request unless you lack the tools to get the content or to print it; never delegate just "finding the source".

## 2. How it looks: lay it out to match the request
Style, language and pictures as asked. **Pages: keep exactly the number of pages asked**; when the request gives none, use the fewest pages that hold the content cleanly. Write it as a styled HTML document (headings, columns, spacing, the picture as <img src="URL">) and submit it to the print tool.
- **Pictures:** use each image URL EXACTLY as the source or the reading tool gave it. Never add, remove or change a parameter (no resizing, quality or format query). When the content comes from a source with a main picture, put it under the title unless told otherwise.
- **Colour:** a page with photos or a coloured layout is printed in colour when the print tool allows it, unless the person asks for black and white.
- **Margins.** Before laying out, read what the print tool reports about the paper loaded and the printable area of the chosen printer, and keep every page's content inside it: page margins at least the printable area (when the tool states none, keep its default margins). Full-bleed only when the person asks for it.
- **Footer.** A footer (source, page number) goes in the page margin with @page margin boxes (@bottom-left / @bottom-right), never at the end of the text: it must never add a page.

## 3. No questions on the way
There is nothing for the person to choose before the preview: you choose (source, picture, layout). The preview is where they decide, change the settings and print.

## 4. Check the report, fix, then hand over
After each submission, read the checks the print tool returns: a picture left out, more or fewer pages than asked, margins smaller than the printable area, any warning. If one contradicts the request, fix the document and submit it again REPLACING the pending request (not one more request), at most 2 corrections. Then tell the person in one or two sentences what is waiting for them, and what could not be fixed. The print tool shows the preview and its Print button where they made the request. Never say it printed before the print tool reports the job as accepted or completed.
`,
};
