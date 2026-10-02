// catalog/skills/magazine-page.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.
//
// The template below was validated by rendering it (headless Chromium
// print-to-PDF, then rasterised) in its one-page and several-page forms:
// margins on every page, nothing within 4 mm of an edge, the one-page form on
// one page. Its margins live in @page and nothing in it has a fixed page
// height: a page layout that pads a block instead (with `@page { margin: 0 }`)
// leaves every page after the first without a margin.

import type { SystemSkill } from '../types';

/** The page template, filled by the model. Exported for the tests that render it. */
export const MAGAZINE_PAGE_TEMPLATE = `<!DOCTYPE html>
<html lang="{{LANG}}">
<head>
<meta charset="utf-8">
<title>{{TITLE}}</title>
<style>
/* ---- Settings: the only values to change ---------------------------------- */
:root {
  --accent: #c8102e;    /* ACCENT colour: kicker, meta line, drop cap, pull-quote rules, figures */
  --hero-height: 108mm; /* photo height. One page: 70-90mm. Several pages: 100-110mm */
  --body-size: 9.5pt;   /* column text. One page: 8.5-9.5pt. Several pages: 9.5-10pt */
}
/* Page margins live HERE, so every page gets them, not only the first.
   At least the printable area the print tool reports; 10mm when it reports none.
   0 only when the person asks for full-bleed. */
@page { size: A4 portrait; margin: 10mm 12mm; }

/* ---- Base: no width, height or overflow on the page, the text flows --------- */
* { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; }

/* ---- Hero photo: content width, top of page 1 only ----------------------------- */
.hero { position: relative; height: var(--hero-height); margin-bottom: 5mm; break-inside: avoid; }
.hero img { display: block; width: 100%; height: 100%; object-fit: cover; }
.kicker { position: absolute; top: 0; left: 0; background: var(--accent); color: #fff; font-family: Arial, Helvetica, sans-serif; font-size: 9pt; font-weight: bold; letter-spacing: 3px; text-transform: uppercase; padding: 3mm 5mm; }
.kicker.inline { position: static; display: inline-block; margin-bottom: 3mm; } /* no photo: the kicker sits above the meta line */
.caption { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0, 0, 0, 0.55); color: #fff; font-family: Arial, Helvetica, sans-serif; font-size: 7pt; line-height: 1.35; padding: 2mm 5mm; }

/* ---- Heading block ------------------------------------------------------------- */
.meta { font-family: Arial, Helvetica, sans-serif; font-size: 7.5pt; color: var(--accent); text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 0.7pt solid var(--accent); padding-bottom: 2.5mm; margin-bottom: 3.5mm; }
.meta .author { color: #555; }
h1 { font-size: 25pt; line-height: 1.05; font-weight: normal; letter-spacing: -0.5px; margin-bottom: 2.5mm; }
.standfirst { font-size: 10.5pt; line-height: 1.4; color: #444; font-style: italic; margin-bottom: 4mm; }

/* ---- Figures band (optional): 2 to 4 key numbers ------------------------------- */
.figures { display: flex; border-top: 0.7pt solid var(--accent); border-bottom: 0.7pt solid var(--accent); margin-bottom: 4mm; break-inside: avoid; }
.figures div { flex: 1; padding: 2mm 3mm; }
.figures div + div { border-left: 0.5pt solid #ccc; }
.figures b { display: block; font-size: 18pt; font-weight: normal; line-height: 1.1; color: var(--accent); }
.figures span { display: block; font-family: Arial, Helvetica, sans-serif; font-size: 7pt; line-height: 1.3; text-transform: uppercase; letter-spacing: 1px; color: #555; }

/* ---- Article: two justified columns that continue from page to page ------------ */
.cols { column-count: 2; column-gap: 7mm; font-size: var(--body-size); line-height: 1.45; text-align: justify; hyphens: auto; }
.cols p { margin-bottom: 2.5mm; orphans: 2; widows: 2; }
.cols p.first::first-letter { font-size: 26pt; float: left; line-height: 0.85; padding-right: 1.5mm; font-weight: bold; color: var(--accent); }
.pull { border-top: 1.5pt solid var(--accent); border-bottom: 1.5pt solid var(--accent); padding: 2.5mm 0; margin: 2mm 0 3mm; font-size: 10pt; line-height: 1.35; font-style: italic; color: var(--accent); text-align: left; break-inside: avoid; }
.subhead { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin: 1mm 0 1.5mm; color: #111; text-align: left; break-inside: avoid; break-after: avoid; }
.subhead + p { break-before: avoid; }

/* ---- Footer: in the flow, at the end of the article ---------------------------- */
.footer { margin-top: 4mm; border-top: 0.5pt solid #999; padding-top: 1.5mm; font-family: Arial, Helvetica, sans-serif; font-size: 6.5pt; color: #777; break-inside: avoid; }
</style>
</head>
<body>

<!-- HERO: delete this whole block when there is no photo (then use <div class="kicker inline">{{KICKER}}</div> above the meta line) -->
<div class="hero">
  <img src="{{HERO_URL}}" alt="{{HERO_ALT}}">
  <div class="kicker">{{KICKER}}</div>
  <div class="caption">{{HERO_CAPTION}}</div>
</div>

<div class="meta">{{SOURCE}} &nbsp;·&nbsp; {{DATE}} &nbsp;·&nbsp; <span class="author">{{AUTHOR}}</span></div>
<h1>{{TITLE}}</h1>
<div class="standfirst">{{STANDFIRST}}</div>

<!-- FIGURES (optional): 2 to 4 numbers taken from the text; delete the block when there are none -->
<div class="figures">
  <div><b>{{FIGURE_1}}</b><span>{{FIGURE_1_LABEL}}</span></div>
  <div><b>{{FIGURE_2}}</b><span>{{FIGURE_2_LABEL}}</span></div>
  <div><b>{{FIGURE_3}}</b><span>{{FIGURE_3_LABEL}}</span></div>
</div>

<div class="cols">
<!-- ARTICLE: the first paragraph carries class="first" (red drop cap); then paragraphs, subheads and at most one pull quote per page -->
<p class="first">{{PARAGRAPH_1}}</p>
<p>{{PARAGRAPH_2}}</p>
<div class="subhead">{{SUBHEAD_1}}</div>
<p>{{PARAGRAPH_3}}</p>
<div class="pull">{{PULLQUOTE}}</div>
<div class="subhead">{{SUBHEAD_2}}</div>
<p>{{PARAGRAPH_4}}</p>
<!-- … as many paragraphs and subheads as the text needs -->
</div>

<div class="footer">{{FOOTER_SOURCE}}</div>

</body>
</html>
`;

const FENCE = '```';

export const magazinePageSkill: SystemSkill = {
  slug: 'magazine-page',
  name: 'Magazine page',
  description:
    'Use when the person asks for a magazine style or magazine layout (print or document): a proven page template to fill, one page or several.',
  requiredBuiltins: [],
  content: `# Magazine page

A proven magazine layout: a large photo at the top with a red kicker and a caption over it, a meta line (source · date · author), a serif headline, an italic standfirst, the article in two justified columns with a drop cap, a pull quote between two rules, spaced capital subheads, the source at the end. Fill the template below; do not redesign it.

## When to use
- The person asks for a magazine style, a magazine layout, "like a magazine page", for a print or for a document.
- It works with any print tool or document tool that takes HTML. When the page is to be printed, the print-request skill still applies: preview, printable area, exact picture URLs, page count.

## How to fill it
1. Copy the whole template. Replace every {{SLOT}}; delete an optional block you do not use (figures band, pull quote, hero) instead of leaving it empty. Leave no {{…}} in the result.
   - KICKER: 2 to 4 words, the topic. HERO_URL: the picture, HERO_ALT: what it shows, HERO_CAPTION: one line.
   - SOURCE, DATE, AUTHOR: as the source gives them; drop one you do not have, with its separator.
   - TITLE, STANDFIRST (one or two sentences), the paragraphs, SUBHEAD (2 to 5 words), PULLQUOTE (a sentence from the text, quoted exactly), FIGURE and FIGURE_LABEL (numbers from the text, never invented), FOOTER_SOURCE (the source name and its address).
   - LANG: the language of the text (en, fr, …), for hyphenation.
2. **Margins** live in \`@page\`, so every page gets them. Set them to at least the printable area the print tool reports; keep 10 mm when it reports none. Never \`@page { margin: 0 }\` with the margin moved into a padded block: only the first page would get it. Full-bleed only when the person asks for it.
3. **Picture**: \`<img src="URL">\` with the URL EXACTLY as the source gave it. It takes the width of the text area and is cropped to \`--hero-height\`. No picture: delete the hero block and use the inline kicker.
4. **Accent colour**: change \`--accent\` only. **Fonts**: keep Georgia and Arial with their fallbacks (installed fonts only, no web fonts).
5. Never give the page a fixed height, never hide an overflow, never position the footer: the text flows, and what does not fit goes to the next page, where you can see it.

## One page
Set \`--hero-height\` to 70-90mm and \`--body-size\` to 8.5-9.5pt. With 10 mm and 12 mm margins, a 75 mm photo, 9 pt text, a pull quote and three subheads, about 500 words of article fit on one A4 page. When the text is longer, shorten it: summarise, merge or drop whole paragraphs, keep the ending. Drop the figures band before cutting text. Never go below 8.5pt, never let the article run onto a second page, never hide what overflows. Then check the page count the print tool reports: 1.

## Several pages
Keep \`--hero-height\` at 100-110mm (the photo is on page 1 only) and \`--body-size\` at 9.5-10pt. The two columns continue from page to page by themselves: add no page breaks and no per-page blocks. A subhead every 3 to 5 paragraphs, at most one pull quote per page, the footer once, at the end of the article. When the person asks for a number of pages, fit the text to it (shorten or keep more of the source), never the font below 9pt.

## Template
${FENCE}html
${MAGAZINE_PAGE_TEMPLATE}${FENCE}
`,
};
