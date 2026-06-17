// services/ioParser.js — Excel → io_tags staging
'use strict';
const ExcelJS = require('exceljs');

/**
 * Read all sheet names from a buffer without loading cell data.
 */
async function listSheets(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets.map(ws => ws.name);
}

/**
 * Parse a worksheet into an array of raw row objects.
 * Returns { headers: string[], rows: [{rowNum, data:{col:val,...}}] }
 * Streams row-by-row; safe for 50k+ rows.
 */
async function parseSheet(buffer, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const ws = sheetName
    ? wb.getWorksheet(sheetName)
    : wb.worksheets[0];

  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);

  const headers = [];
  const rows    = [];
  let headerRowNum = null;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = row.values; // 1-based array (index 0 is undefined)

    // First non-empty row = header row
    if (headerRowNum === null) {
      headerRowNum = rowNumber;
      for (let i = 1; i < values.length; i++) {
        const h = values[i] != null ? String(values[i]).trim() : `COL_${i}`;
        headers.push(h);
      }
      return;
    }

    // Data rows
    const data = {};
    for (let i = 0; i < headers.length; i++) {
      const cell = values[i + 1];
      data[headers[i]] = cell != null ? cellValue(cell) : null;
    }
    rows.push({ rowNum: rowNumber, data });
  });

  return { headers, rows, sheetName: ws.name };
}

function cellValue(cell) {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'object') {
    // RichText
    if (cell.richText) return cell.richText.map(r => r.text).join('');
    // Formula
    if (cell.result !== undefined) return cell.result;
    // hyperlink
    if (cell.text) return cell.text;
  }
  return cell;
}

module.exports = { listSheets, parseSheet };
