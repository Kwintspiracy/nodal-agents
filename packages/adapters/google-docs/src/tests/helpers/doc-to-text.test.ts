// @nodal-agents/adapter-google-docs — doc-to-text helper tests

import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { docBodyToText } from '../../helpers/doc-to-text';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeParagraph(text: string, namedStyleType?: string): docs_v1.Schema$StructuralElement {
  return {
    paragraph: {
      paragraphStyle: namedStyleType ? { namedStyleType } : undefined,
      elements: [
        {
          textRun: {
            content: text,
          },
        },
      ],
    },
  };
}

function makeMultiRunParagraph(runs: string[]): docs_v1.Schema$StructuralElement {
  return {
    paragraph: {
      elements: runs.map((content) => ({ textRun: { content } })),
    },
  };
}

function makeTableElement(rows: string[][]): docs_v1.Schema$StructuralElement {
  return {
    table: {
      tableRows: rows.map((cells) => ({
        tableCells: cells.map((text) => ({
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: text } }],
              },
            },
          ],
        })),
      })),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('docBodyToText', () => {
  it('handles an empty body', () => {
    const result = docBodyToText({ content: [] });
    expect(result).toBe('');
  });

  it('handles undefined content', () => {
    const result = docBodyToText({});
    expect(result).toBe('');
  });

  it('converts a single paragraph with one run', () => {
    const body: docs_v1.Schema$Body = {
      content: [makeParagraph('Hello world\n')],
    };
    expect(docBodyToText(body)).toBe('Hello world\n');
  });

  it('converts multiple paragraphs in order', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        makeParagraph('First line\n'),
        makeParagraph('Second line\n'),
        makeParagraph('Third line\n'),
      ],
    };
    expect(docBodyToText(body)).toBe('First line\nSecond line\nThird line\n');
  });

  it('joins multiple text runs in a paragraph', () => {
    const body: docs_v1.Schema$Body = {
      content: [makeMultiRunParagraph(['Hello', ' ', 'world', '\n'])],
    };
    expect(docBodyToText(body)).toBe('Hello world\n');
  });

  it('handles heading paragraphs (namedStyleType)', () => {
    // Headings have the same text extraction — content is what matters
    const body: docs_v1.Schema$Body = {
      content: [
        makeParagraph('Introduction\n', 'HEADING_1'),
        makeParagraph('Some body text\n', 'NORMAL_TEXT'),
      ],
    };
    const text = docBodyToText(body);
    expect(text).toBe('Introduction\nSome body text\n');
  });

  it('converts a table to tab-separated cells with newlines', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        makeTableElement([
          ['Name', 'Age'],
          ['Alice', '30'],
        ]),
      ],
    };
    const text = docBodyToText(body);
    expect(text).toContain('Name\tAge\n');
    expect(text).toContain('Alice\t30\n');
  });

  it('handles a section break as a newline separator', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        makeParagraph('Before break\n'),
        { sectionBreak: {} },
        makeParagraph('After break\n'),
      ],
    };
    const text = docBodyToText(body);
    expect(text).toContain('Before break\n');
    expect(text).toContain('After break\n');
  });

  it('handles inline object elements (images) with placeholder', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        {
          paragraph: {
            elements: [
              { textRun: { content: 'Before ' } },
              { inlineObjectElement: { inlineObjectId: 'img1' } },
              { textRun: { content: ' after\n' } },
            ],
          },
        },
      ],
    };
    const text = docBodyToText(body);
    expect(text).toBe('Before [image] after\n');
  });

  it('handles paragraphs with no elements', () => {
    const body: docs_v1.Schema$Body = {
      content: [{ paragraph: { elements: [] } }, makeParagraph('Non-empty\n')],
    };
    const text = docBodyToText(body);
    expect(text).toBe('Non-empty\n');
  });

  it('handles textRun with missing content gracefully', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        {
          paragraph: {
            elements: [
              { textRun: {} }, // no content
              { textRun: { content: 'hello\n' } },
            ],
          },
        },
      ],
    };
    const text = docBodyToText(body);
    expect(text).toBe('hello\n');
  });

  it('synthetic document fixture: headings, paragraphs, table', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        makeParagraph('My Document\n', 'TITLE'),
        makeParagraph('Chapter 1\n', 'HEADING_1'),
        makeParagraph('This is the first paragraph of chapter 1.\n', 'NORMAL_TEXT'),
        makeParagraph('Section 1.1\n', 'HEADING_2'),
        makeMultiRunParagraph(['Bold text', ' and normal text.\n']),
        makeTableElement([
          ['Header A', 'Header B', 'Header C'],
          ['Row1A', 'Row1B', 'Row1C'],
        ]),
        makeParagraph('Chapter 2\n', 'HEADING_1'),
        makeParagraph('End of document.\n', 'NORMAL_TEXT'),
      ],
    };

    const text = docBodyToText(body);

    // All content present
    expect(text).toContain('My Document\n');
    expect(text).toContain('Chapter 1\n');
    expect(text).toContain('This is the first paragraph of chapter 1.\n');
    expect(text).toContain('Section 1.1\n');
    expect(text).toContain('Bold text and normal text.\n');
    expect(text).toContain('Header A\tHeader B\tHeader C\n');
    expect(text).toContain('Row1A\tRow1B\tRow1C\n');
    expect(text).toContain('Chapter 2\n');
    expect(text).toContain('End of document.\n');

    // Ordered correctly
    expect(text.indexOf('Chapter 1')).toBeLessThan(text.indexOf('Section 1.1'));
    expect(text.indexOf('Section 1.1')).toBeLessThan(text.indexOf('Chapter 2'));
  });
});
