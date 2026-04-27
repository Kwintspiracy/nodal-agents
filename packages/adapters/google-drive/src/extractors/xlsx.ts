// @nodalai/adapter-google-drive — XLSX extractor using exceljs

import ExcelJS from 'exceljs';

/**
 * Extract text from an .xlsx buffer using exceljs.
 * Renders all sheets as TSV-like text: "--- Sheet: Name ---\ncol1\tcol2\t..."
 * Caps each sheet at 200 rows to keep context bounded.
 */
export async function extractXlsxText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // exceljs types pre-date @types/node's generic Buffer — use unknown cast
  await (workbook.xlsx.load as (b: unknown) => Promise<ExcelJS.Workbook>)(buffer);

  const parts: string[] = [];
  const ROW_CAP = 200;

  workbook.eachSheet((worksheet) => {
    parts.push(`--- Sheet: ${worksheet.name} ---`);
    let rowCount = 0;

    worksheet.eachRow((row) => {
      if (rowCount >= ROW_CAP) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const val = cell.value;
        if (val === null || val === undefined) {
          cells.push('');
        } else if (typeof val === 'object' && 'result' in val) {
          // Formula cell — use cached result
          cells.push(String((val as { result: unknown }).result ?? ''));
        } else if (typeof val === 'object' && val instanceof Date) {
          cells.push(val.toISOString().slice(0, 10));
        } else {
          cells.push(String(val));
        }
      });
      if (cells.length > 0) {
        parts.push(cells.join('\t'));
        rowCount++;
      }
    });

    if (rowCount >= ROW_CAP) {
      parts.push(`[sheet truncated at ${ROW_CAP} rows]`);
    }
  });

  return parts.join('\n');
}
