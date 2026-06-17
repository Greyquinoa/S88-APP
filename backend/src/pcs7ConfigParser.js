// src/pcs7ConfigParser.js — Extract project-level hardware IDs from a PCS7 SimaticML export.
// JS port of the Python xml_to_config.py script.
'use strict';
const xml2js = require('xml2js');

const NS = 'http://www.siemens.com/automation/2005/SimaticML';

// xml2js strips namespaces when explicitCharkey/explicitRoot options are used.
// We parse with xmlns preservation turned off for simplicity.
const PARSE_OPTS = {
  explicitArray:    true,
  explicitCharkey:  false,
  attrkey:          '$',
  charkey:          '_',
  tagNameProcessors: [xml2js.processors.stripPrefix],
};

function attr(el, name) {
  return el?.$?.[name] || '';
}

function childText(el, tag) {
  const node = el?.[tag]?.[0];
  if (!node) return '';
  return typeof node === 'string' ? node.trim() : (node._ || '').trim();
}

// Walk an element tree looking for a child matching pred(el) — depth-first, first match.
function findDeep(el, pred) {
  if (!el || typeof el !== 'object') return null;
  if (pred(el)) return el;
  for (const key of Object.keys(el)) {
    if (key === '$') continue;
    const children = Array.isArray(el[key]) ? el[key] : [el[key]];
    for (const child of children) {
      const found = findDeep(child, pred);
      if (found) return found;
    }
  }
  return null;
}

function findAllDeep(el, pred, results = []) {
  if (!el || typeof el !== 'object') return results;
  if (pred(el)) results.push(el);
  for (const key of Object.keys(el)) {
    if (key === '$') continue;
    const children = Array.isArray(el[key]) ? el[key] : [el[key]];
    for (const child of children) findAllDeep(child, pred, results);
  }
  return results;
}

function isElement(tagName) {
  return el => el?.$ !== undefined && el._tagName === tagName;
}

// xml2js doesn't store the tag name on the element object by default.
// We do a simpler approach: find by walking known subtrees.

/**
 * Parse a PCS7 SimaticML XML buffer/string.
 * Returns an object with the same keys as the Python script's config dict.
 * Missing values are empty strings.
 */
async function parsePcs7Config(xmlBuffer) {
  const text = Buffer.isBuffer(xmlBuffer) ? xmlBuffer.toString('utf8') : xmlBuffer;
  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(text, PARSE_OPTS);
  } catch (e) {
    throw new Error(`XML parse error: ${e.message}`);
  }

  // Root element: <Document> or namespace-qualified variant.
  const root = parsed.Document || parsed[Object.keys(parsed)[0]];
  if (!root) throw new Error('No root Document element found');

  const docInfo = root.DocumentInfo?.[0];
  const project = root.Project?.[0];
  if (!project) throw new Error('No <Project> element found — is this a PCS7 SimaticML export?');

  const exportUser = docInfo ? (attr(docInfo, 'UserName') || '') : '';
  const projectName = attr(project, 'Name');
  const projectIdVal = attr(project, 'ID');

  // ObjectList inside Project
  const projOL = project.ObjectList?.[0];

  // Device (Type=Central) — first Device child
  const devices = projOL?.Device || [];
  const device = devices[0];
  const deviceName = attr(device, 'Name');
  const deviceId = attr(device, 'ID');

  // CPU: DeviceItem with Type=ControllerTarget — inside Device/ObjectList
  const devOL = device?.ObjectList?.[0];
  const devItems = devOL?.DeviceItem || [];
  const cpu = devItems.find(di => attr(di, 'Type') === 'ControllerTarget');
  const cpuId = attr(cpu, 'ID');

  // PlantHierarchyFolder trees — inside Project/ObjectList (may be nested under Device or direct)
  // PCS7 exports typically place them directly under Project/ObjectList alongside Device.
  const allFolders = projOL?.PlantHierarchyFolder || [];

  function findFolder(list, predFn) {
    for (const f of list) {
      if (predFn(f)) return f;
      const nested = f.ObjectList?.[0]?.PlantHierarchyFolder || [];
      const found = findFolder(nested, predFn);
      if (found) return found;
    }
    return null;
  }

  function findFolderChildren(f) {
    return f?.ObjectList?.[0]?.PlantHierarchyFolder || [];
  }

  // ProcessCell
  const pc = findFolder(allFolders, f => attr(f, 'Type') === 'ProcessCell');
  const processCell = attr(pc, 'Name');
  const processCellId = attr(pc, 'ID');

  // Unit — first Unit inside ProcessCell
  const pcChildren = findFolderChildren(pc);
  const unit = findFolder(pcChildren, f => attr(f, 'Type') === 'Unit');
  const unitName = attr(unit, 'Name');
  const unitId = attr(unit, 'ID');

  // CM folder — child of Unit named "CM"
  const unitChildren = findFolderChildren(unit);
  const cmFolder = unitChildren.find(f => attr(f, 'Name') === 'CM');
  const cmFolderId = attr(cmFolder, 'ID');

  // unit_author — inside Unit/AttributeList/Author
  let unitAuthor = '';
  if (unit) {
    const al = unit.AttributeList?.[0];
    unitAuthor = (al?.Author?.[0] || '').toString().trim();
  }

  const config = {
    project_name:    projectName,
    project_id_val:  projectIdVal,
    device_name:     deviceName,
    device_id:       deviceId,
    cpu_id:          cpuId,
    process_cell:    processCell,
    process_cell_id: processCellId,
    unit_name:       unitName,
    unit_id:         unitId,
    cm_folder_id:    cmFolderId,
    export_user:     exportUser,
    unit_author:     unitAuthor,
  };

  const missing = Object.entries(config).filter(([, v]) => !v).map(([k]) => k);
  return { config, missing };
}

module.exports = { parsePcs7Config };
