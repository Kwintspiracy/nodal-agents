// no-hardcoded-user.test.ts — Finding I-5: a system skill must never hardcode
// a specific user's name (invariant #6, "no per-user hardcoded values"). This
// scans every shipped system skill's content for the operator's own name so
// the regression can't silently reappear in a future skill edit.

import { describe, it, expect } from 'vitest';
import { systemSkills } from '../index';
import { MAGAZINE_PAGE_TEMPLATE } from './magazine-page';

describe('system skill catalog — no hardcoded per-user values (I-5)', () => {
  it('no skill content mentions "Quentin"', () => {
    for (const skill of systemSkills) {
      expect(skill.content, `${skill.slug} must not reference a specific user by name`).not.toMatch(
        /quentin/i,
      );
    }
  });
});

describe('print-request skill', () => {
  const skill = systemSkills.find((s) => s.slug === 'print-request');

  it('is registered in the catalog as a capability skill with no builtin requirement', () => {
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('Print requests');
    expect(skill?.requiredBuiltins).toEqual([]);
    expect(skill?.kind ?? 'capability').toBe('capability');
    expect(skill?.content).toContain('the only valid answer is a print preview');
  });

  it('lays out inside the printable area the print tool reports, full-bleed only on request', () => {
    expect(skill?.content).toContain(
      "Before laying out, read what the print tool reports about the paper loaded and the printable area of the chosen printer, and keep every page's content inside it: page margins at least the printable area (when the tool states none, keep its default margins). Full-bleed only when the person asks for it.",
    );
  });

  it('tells the model to check the report, fix and replace the pending request', () => {
    const c = skill?.content ?? '';
    expect(c).toContain('EXACTLY as the source or the reading tool gave it');
    expect(c).toContain('Never add, remove or change a parameter');
    expect(c).toContain('printed in colour when the print tool allows it');
    expect(c).toContain('exactly the number of pages asked');
    expect(c).toContain('REPLACING the pending request');
    expect(c).toContain('at most 2 corrections');
    expect(c).not.toContain('Then stop');
    expect(c).not.toContain('natural length');
    expect(skill?.description).toContain('Check the print tool report and fix the page');
  });

  it('names no user, e-mail, printer model or server', () => {
    const text = `${skill?.description}\n${skill?.content}`;
    expect(text).not.toMatch(/quentin/i);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b(hp|smart[- ]?tank|deskjet|laserjet|epson|canon|brother)\b/i);
    expect(text).not.toMatch(/https?:\/\/(?!URL)/);
  });
});

describe('magazine-page skill', () => {
  const skill = systemSkills.find((s) => s.slug === 'magazine-page');
  const content = skill?.content ?? '';
  const css = /<style>([\s\S]*?)<\/style>/.exec(content)?.[1] ?? '';

  it('is registered in the catalog as a capability skill with no builtin requirement', () => {
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('Magazine page');
    expect(skill?.requiredBuiltins).toEqual([]);
    expect(skill?.kind ?? 'capability').toBe('capability');
    expect(skill?.description).toBe(
      'Use when the person asks for a magazine style or magazine layout (print or document): a proven page template to fill, one page or several.',
    );
  });

  it('carries the whole template, its named slots and both variants', () => {
    expect(content).toContain(MAGAZINE_PAGE_TEMPLATE);
    for (const slot of [
      'PAGE_MARGIN',
      'KICKER',
      'HERO_URL',
      'HERO_CAPTION',
      'SOURCE',
      'DATE',
      'AUTHOR',
      'TITLE',
      'STANDFIRST',
      'PARAGRAPH_1',
      'SUBHEAD_1',
      'PULLQUOTE',
      'FIGURE_1',
      'FOOTER_SOURCE',
    ]) {
      expect(MAGAZINE_PAGE_TEMPLATE).toContain(`{{${slot}}}`);
    }
    expect(content).toContain('## One page');
    expect(content).toContain('## Several pages');
    expect(content).toContain('<img src="URL">` with the URL EXACTLY as the source gave it');
  });

  it('takes the page margin from what the print tool reports, in @page, never a value of its own', () => {
    // The @page block, its {{SLOT}} braces included.
    const page = /@page\s*\{((?:[^{}]|\{\{[A-Z_]+\}\})*)\}/.exec(css)?.[1] ?? '';
    expect(page.match(/margin\s*:\s*([^;]+)/)?.[1]?.trim()).toBe('{{PAGE_MARGIN}}');
    // No length anywhere in @page: the margin is the printer's, not the template's.
    expect(page).not.toMatch(/\d+(\.\d+)?\s*(mm|cm|in|pt|px)/);
    expect(css).not.toMatch(/@page\s*\{[^}]*margin\s*:\s*0\s*[;}]/);
    expect(content).toContain(
      '**Margins: read first what the print tool reports** for the chosen printer: its printable area and its default page margin. PAGE_MARGIN is that default page margin, never less than the printable area.',
    );
    expect(content).toContain(
      "When the tool reports none, or nothing prints the page, delete the `margin` declaration from `@page`: the tool's own default margin applies.",
    );
    expect(content).toContain('Full-bleed only when the person explicitly asks for it.');
  });

  it('puts the footer (source, page number) in the @page margin boxes, never in the flow', () => {
    // The page rule that carries the margin boxes (nested braces: not the plain @page block).
    const boxes =
      /@page\s*\{\s*@bottom-left\s*\{((?:[^{}]|\{\{[A-Z_]+\}\})*)\}\s*@bottom-right\s*\{([^{}]*)\}\s*\}/.exec(
        css,
      );
    expect(boxes?.[1]).toContain('content: "{{FOOTER_SOURCE}}"');
    expect(boxes?.[2]).toContain('content: "Page " counter(page) " / " counter(pages)');
    expect(css).not.toMatch(/\.footer/);
    expect(MAGAZINE_PAGE_TEMPLATE).not.toMatch(/<[^>]*class="footer"/);
    expect(MAGAZINE_PAGE_TEMPLATE.match(/\{\{FOOTER_SOURCE\}\}/g)).toHaveLength(1);
  });

  it('tells every print request that a footer lives in the margin and never adds a page', () => {
    const printRequest = systemSkills.find((s) => s.slug === 'print-request')?.content ?? '';
    expect(printRequest).toContain(
      'A footer (source, page number) goes in the page margin with @page margin boxes (@bottom-left / @bottom-right), never at the end of the text: it must never add a page.',
    );
  });

  it('has no fixed page height, no hidden overflow and no positioned footer: the text flows onto the next page', () => {
    expect(css).not.toMatch(/overflow\s*:\s*hidden/);
    expect(css).not.toMatch(/297\s*mm/);
    expect(css).not.toMatch(/body\s*\{[^}]*\b(height|width)\s*:/);
    const footer = /\.footer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(footer).not.toMatch(/position\s*:/);
    expect(css).toMatch(/\.pull\s*\{[^}]*break-inside:\s*avoid/);
    expect(css).toMatch(/\.subhead\s*\{[^}]*break-after:\s*avoid/);
    expect(css).toMatch(/\.figures\s*\{[^}]*break-inside:\s*avoid/);
  });

  it('names no user, e-mail, printer model, server or web address', () => {
    const text = `${skill?.description}\n${content}`;
    expect(text).not.toMatch(/quentin/i);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(
      /\b(hp|smart[- ]?tank|deskjet|laserjet|epson|canon|brother|officejet|envy)\b/i,
    );
    expect(text).not.toMatch(/https?:\/\//);
  });
});
