// src/routes/simitExport.js — SIMIT.xlsm export
// Strategy: load SIMIT_template.xlsm as a zip, surgically replace only
// <sheetData> and <dimension>/<autoFilter> inside the existing sheet1.xml,
// and replace sharedStrings.xml. Everything else — vbaProject.bin,
// drawing1.xml, vmlDrawing1.vml, ctrlProp1.xml, all rels — stays identical.
//
// Dynamic columns (G onward): one column per unique "BlockName.VarName" across
// all CM types in the project. Both parameter variables AND signal variables are
// included. The value written per instance is:
//   - Signal var: the actual signal tag from signal_mappings / instance_ios
//                 (e.g. "TT01_PV") — falls back to lib default if unmapped.
//   - Parameter var: lib default val (no per-instance parameter overrides in DB).
//
// Fixed columns A–F:
//   A HIERARCHY   ← rIX\<folder path>\
//   B TEMPLATE    ← cm_type
//   C CHART       ← instance_name
//   D COUPLING    ← T16_Controller_TagName
//   E ChartName   ← instance_name
//   F ChartComment← ''
'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const JSZip    = require('jszip');
const { getDb }                      = require('../db');
const { loadMappingsForProject }     = require('../signalMappings');
const { loadConnectionIOsForProject } = require('../connections');

const router = express.Router();

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'SIMIT_template.xlsm');

// Fixed header labels for columns A–F.
const FIXED_HEADERS = ['HIERARCHY', 'TEMPLATE', 'CHART', 'COUPLING', 'ChartName', 'ChartComment'];

// 0-based column index → Excel column letter (0→A, 25→Z, 26→AA …).
function colLetter(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Build sharedStrings.xml. Returns { xml, indexMap: string → index }.
function buildSharedStrings(allStrings) {
  const indexMap = new Map();
  const unique   = [];
  for (const s of allStrings) {
    const key = String(s);
    if (!indexMap.has(key)) { indexMap.set(key, unique.length); unique.push(key); }
  }
  const NS  = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const sis = unique.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('');
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="${NS}" count="${allStrings.length}" uniqueCount="${unique.length}">${sis}</sst>`;
  return { xml, indexMap };
}

// Build <sheetData> XML. All non-empty cells use shared-string refs.
function buildSheetData(rows, indexMap) {
  const rowXmls = rows.map((cells, ri) => {
    const rowNum = ri + 1;
    const cellXmls = cells.map((val, ci) => {
      if (val === '' || val == null) return '';
      const ref = `${colLetter(ci)}${rowNum}`;
      const si  = indexMap.get(String(val));
      return `<c r="${ref}" t="s"><v>${si}</v></c>`;
    }).join('');
    return `<row r="${rowNum}">${cellXmls}</row>`;
  }).join('');
  return `<sheetData>${rowXmls}</sheetData>`;
}

// Patch original sheet1.xml: replace only <sheetData>, <dimension>, <autoFilter>.
function patchSheetXml(originalXml, newSheetData, totalRows, numCols) {
  const lastCol = colLetter(numCols - 1);
  const range   = `A1:${lastCol}${totalRows}`;
  let xml = originalXml;
  xml = xml.replace(/<dimension ref="[^"]*"/, `<dimension ref="${range}"`);
  xml = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, newSheetData);
  xml = xml.replace(/<autoFilter ref="[^"]*"/, `<autoFilter ref="${range}"`);
  return xml;
}

// Build a backslash-terminated PCS7 hierarchy path.
function buildFolderPath(folderId, folderById) {
  const parts = [];
  let cur = folderId != null ? folderById[folderId] : null;
  while (cur) {
    parts.unshift(cur.name || '');
    cur = cur.parent_id != null ? folderById[cur.parent_id] : null;
  }
  if (!parts.length) return '';
  return 'rIX\\' + parts.join('\\') + '\\';
}

// ── GET /api/simit-export/:projectId ─────────────────────────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = req.params.projectId;

    const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // ── Folder path lookup ────────────────────────────────────────────────────
    const folderRows = await db.prepare(`
      SELECT id, parent_id, name FROM project_hierarchy_folders
      WHERE project_id = ? ORDER BY sort_order, id
    `).all(projectId);
    const folderById = Object.fromEntries(folderRows.map(f => [f.id, f]));

    // ── Controller name lookup ────────────────────────────────────────────────
    const ctrlRows = await db.prepare(`
      SELECT id, T16_Controller_TagName FROM hw_controllers WHERE project_id = ?
    `).all(projectId);
    const ctrlById = {};
    for (const c of ctrlRows) {
      const name = c.T16_Controller_TagName ?? c.t16_controller_tagname ?? '';
      ctrlById[c.id] = name;
    }

    // ── Instances ─────────────────────────────────────────────────────────────
    const instanceRows = await db.prepare(`
      SELECT cm_type, instance_name, hw_controller_id, folder_id
      FROM project_instances
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(projectId);

    // ── Per-instance signal tag lookups (same as XML generator) ───────────────
    // Priority: manual signal_mappings wins over reconciled instance_ios.
    // signalMaps[instanceName]["block.var"] = { tag, dummy? }
    const signalMaps  = await loadMappingsForProject(db, projectId);
    const connIOs     = await loadConnectionIOsForProject(db, projectId);

    // Merge connIOs into signalMaps (manual mapping wins, same logic as generate.js).
    for (const [instName, pins] of Object.entries(connIOs)) {
      const bucket = (signalMaps[instName] ||= {});
      for (const [key, entry] of Object.entries(pins)) {
        if (!bucket[key]) bucket[key] = entry;
      }
    }

    // ── Load all blocks + variables per CM type ───────────────────────────────
    // cmTypeVars: { cmTypeName → Map<"Block.Var", { val, isSignal }> }
    // isSignal=true  → write the instance's actual signal tag as the value
    // isSignal=false → write lib default val
    const cmTypeVars = new Map();
    const distinctTypes = [...new Set(instanceRows.map(r => r.cm_type))];

    for (const cmTypeName of distinctTypes) {
      const cm = await db.prepare(
        `SELECT id FROM lib_cm_types WHERE name = ? AND project_id = ?`
      ).get(cmTypeName, projectId);
      if (!cm) continue;

      const blocks = await db.prepare(`
        SELECT id, name FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order, id
      `).all(cm.id);

      const varMap = new Map(); // "Block.Var" → { val, isSignal }
      for (const blk of blocks) {
        const vars = await db.prepare(`
          SELECT name, val, vtype FROM lib_variables
          WHERE block_id = ? ORDER BY sort_order, id
        `).all(blk.id);
        for (const v of vars) {
          const key      = `${blk.name}.${v.name}`;
          const isSignal = v.vtype === 'Signal';
          varMap.set(key, { val: v.val ?? '', isSignal });
        }
      }
      cmTypeVars.set(cmTypeName, varMap);
    }

    // ── Build global ordered column list (union, preserving insertion order) ──
    const globalColOrder = [];
    const globalColSet   = new Set();
    for (const inst of instanceRows) {
      const varMap = cmTypeVars.get(inst.cm_type);
      if (!varMap) continue;
      for (const key of varMap.keys()) {
        if (!globalColSet.has(key)) { globalColSet.add(key); globalColOrder.push(key); }
      }
    }

    // Pre-built column index map for O(1) lookup.
    const colIndexOf = new Map(globalColOrder.map((k, i) => [k, FIXED_HEADERS.length + i]));

    // ── Build header row ──────────────────────────────────────────────────────
    const headers = [...FIXED_HEADERS, ...globalColOrder];
    const numCols = headers.length;

    // ── Build data rows ───────────────────────────────────────────────────────
    const dataRows = instanceRows.map(inst => {
      const row = new Array(numCols).fill('');

      // Fixed columns
      row[0] = buildFolderPath(inst.folder_id, folderById);
      row[1] = inst.cm_type         || '';
      row[2] = inst.instance_name   || '';
      row[3] = ctrlById[inst.hw_controller_id] || '';
      row[4] = inst.instance_name   || '';
      // row[5] ChartComment stays ''

      // Dynamic variable columns
      const varMap    = cmTypeVars.get(inst.cm_type);
      const instSigMap = signalMaps[inst.instance_name] || {};

      if (varMap) {
        for (const [key, { val, isSignal }] of varMap.entries()) {
          const colIdx = colIndexOf.get(key);

          if (isSignal) {
            // Use the actual mapped signal tag; skip dummy signals (unmatched).
            const sig = instSigMap[key];
            if (sig && !sig.dummy && sig.tag) {
              row[colIdx] = sig.tag;
            }
            // If no real signal mapping exists, leave cell empty.
          } else {
            // Parameter variable: check if a static value override exists
            // from the signal map (composite wire spec overwrites val via tag field).
            const sig = instSigMap[key];
            if (sig && !sig.dummy && sig.tag) {
              // A non-dummy signal on a parameter var means it was wired to a value
              row[colIdx] = sig.tag;
            } else if (val !== '') {
              row[colIdx] = val;
            }
          }
        }
      }
      return row;
    });

    // ── Collect all strings for sharedStrings ─────────────────────────────────
    const allRows = [headers, ...dataRows];
    const allStrings = [];
    for (const row of allRows) {
      for (const v of row) { if (v !== '' && v != null) allStrings.push(String(v)); }
    }

    // ── Build XML ─────────────────────────────────────────────────────────────
    const { xml: ssXml, indexMap } = buildSharedStrings(allStrings);
    const sheetDataXml = buildSheetData(allRows, indexMap);

    // ── Patch template zip ────────────────────────────────────────────────────
    const templateBuf = fs.readFileSync(TEMPLATE_PATH);
    const zip = await JSZip.loadAsync(templateBuf);

    const origSheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const patchedSheetXml = patchSheetXml(origSheetXml, sheetDataXml, allRows.length, numCols);
    zip.file('xl/worksheets/sheet1.xml', patchedSheetXml);
    zip.file('xl/sharedStrings.xml', ssXml);

    const outBuf = await zip.generateAsync({
      type:               'nodebuffer',
      compression:        'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const filename = `SIMIT_${project.name}_${new Date().toISOString().slice(0, 10)}.xlsm`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel.sheet.macroenabled.12');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', outBuf.length);
    res.end(outBuf);

  } catch (err) {
    console.error('[simitExport] Error:', err.message || err);
    if (err.stack) console.error(err.stack);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;
