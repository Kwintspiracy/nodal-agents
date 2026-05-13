// @nodal-agents/adapter-google-docs — helper: convert document body to plain text

import type { docs_v1 } from 'googleapis';

/**
 * Extract plain text from a Google Docs document body.
 *
 * Processes structural elements in order:
 * - Paragraphs: joins all textRun content, adds a newline at end
 * - Tables: iterates cells row-by-row, tab-separated, newline after each row
 * - SectionBreaks and other structural elements: newline separator
 *
 * Returns the full document text as a single string.
 */
export function docBodyToText(body: docs_v1.Schema$Body): string {
  const parts: string[] = [];

  for (const element of body.content ?? []) {
    if (element.paragraph) {
      parts.push(paragraphToText(element.paragraph));
    } else if (element.table) {
      parts.push(tableToText(element.table));
    } else if (element.sectionBreak) {
      // Section breaks act as separators
      parts.push('\n');
    }
  }

  return parts.join('');
}

/**
 * Convert a single paragraph to plain text.
 * Joins textRun content fragments; adds a trailing newline.
 */
function paragraphToText(paragraph: docs_v1.Schema$Paragraph): string {
  const runs: string[] = [];

  for (const element of paragraph.elements ?? []) {
    if (element.textRun?.content) {
      runs.push(element.textRun.content);
    } else if (element.inlineObjectElement) {
      // Inline images / objects — use a placeholder
      runs.push('[image]');
    } else if (element.horizontalRule) {
      runs.push('\n---\n');
    }
  }

  return runs.join('');
}

/**
 * Convert a table to plain text: tab-separated cells, newline per row.
 */
function tableToText(table: docs_v1.Schema$Table): string {
  const rows: string[] = [];

  for (const tableRow of table.tableRows ?? []) {
    const cells: string[] = [];
    for (const cell of tableRow.tableCells ?? []) {
      // Each cell has its own content array (paragraphs)
      const cellText = (cell.content ?? [])
        .map((el) => (el.paragraph ? paragraphToText(el.paragraph) : ''))
        .join('')
        .replace(/\n$/, ''); // strip trailing newline from last paragraph
      cells.push(cellText);
    }
    rows.push(cells.join('\t') + '\n');
  }

  return rows.join('');
}
