// src/xmlParser.js — Parse SIE_LIB.XML into JS objects (runs once on upload)
// Mirrors the browser parseLibrary() but runs in Node via xml2js
'use strict';
const xml2js = require('xml2js');

function attr(el, name) {
  return el?.$ ?.[name] || '';
}

function childText(el, tag) {
  const node = el?.[tag]?.[0];
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'object') return (node._ || '').trim();
  return '';
}

function parseVars(blkOL) {
  const vars = [];
  let sortOrder = 0;
  for (const cv of blkOL.ControlVariable || []) {
    const al = cv.AttributeList?.[0] || {};
    const links = [];
    for (const ic of cv.LinkList?.[0]?.InterconnectionSource || []) {
      const tid = attr(ic, 'TargetID').replace(/^#/, '');
      if (tid) links.push(tid);
    }
    vars.push({
      libId:       attr(cv, 'ID'),
      name:        attr(cv, 'Name'),
      dir:         attr(cv, 'Type'),
      dtype:       childText(al, 'DataType'),
      val:         childText(al, 'Value'),
      comment:     childText(al, 'Comment'),
      vtype:       childText(al, 'VariableType'),
      enumeration: childText(al, 'Enumeration'),
      negation:    childText(al, 'Negation') === 'true' ? 1 : 0,
      libLinks:    links,
      sortOrder:   sortOrder++,
    });
  }
  return vars;
}

function parseMsgs(blkOL) {
  const msgs = [];
  let sortOrder = 0;
  for (const m of blkOL.Message || []) {
    const al = m.AttributeList?.[0] || {};
    msgs.push({
      name:      attr(m, 'Name'),
      batch:     childText(al, 'BatchID'),
      cls:       childText(al, 'Class'),
      event:     childText(al, 'Event'),
      origin:    childText(al, 'Origin'),
      osarea:    childText(al, 'OSArea'),
      prio:      childText(al, 'Priority'),
      ack:       childText(al, 'WithAcknowledgement') === 'true' ? 1 : 0,
      sortOrder: sortOrder++,
    });
  }
  return msgs;
}

function parseBlocks(folderOL) {
  const blocks = [];
  let sortOrder = 0;
  for (const blk of folderOL.PlantHierarchyFolder || []) {
    const al      = blk.AttributeList?.[0] || {};
    if (childText(al, 'BasicRequirement') === 'true') continue;
    const optRaw  = childText(al, 'Optional');
    const blkOL   = blk.ObjectList?.[0] || {};
    blocks.push({
      name:      attr(blk, 'Name'),
      comment:   childText(al, 'Comment'),
      optional:  optRaw === 'true' ? 1 : 0,
      vars:      parseVars(blkOL),
      msgs:      parseMsgs(blkOL),
      sortOrder: sortOrder++,
    });
  }
  return blocks;
}

// Parse role slots from EM/EPH ObjectList.
// EM uses ControlModuleAssignment; EPH uses EquipmentModuleAssignment.
// Entries with BasicRequirement=true are type-constraint declarations — skip them.
function parseRoles(folderOL) {
  const roles = [];
  let sortOrder = 0;
  for (const cma of folderOL.ControlModuleAssignment || []) {
    const al = cma.AttributeList?.[0] || {};
    if (childText(al, 'BasicRequirement') === 'true') continue;
    const role = childText(al, 'Role');
    if (role) roles.push({ role, roleKind: 'cm', sortOrder: sortOrder++ });
  }
  for (const ema of folderOL.EquipmentModuleAssignment || []) {
    const al = ema.AttributeList?.[0] || {};
    if (childText(al, 'BasicRequirement') === 'true') continue;
    const role = childText(al, 'Role');
    if (role) roles.push({ role, roleKind: 'em', sortOrder: sortOrder++ });
  }
  return roles;
}

async function parseLibraryXML(buffer) {
  const raw = await xml2js.parseStringPromise(buffer, {
    explicitArray:      true,
    explicitCharkey:    false,
    tagNameProcessors:  [xml2js.processors.stripPrefix],
    attrNameProcessors: [xml2js.processors.stripPrefix],
  });

  // Navigate: Document > Project > ObjectList > ProjectLibrary > ObjectList > Templates > ObjectList > PlantHierarchyFolder[]
  const doc  = Object.values(raw)[0];
  const proj = doc?.Project?.[0] || doc?.ProjectLibrary?.[0];

  // Try multiple possible paths — different PCS7 versions nest slightly differently
  const folders =
    proj?.ObjectList?.[0]?.ProjectLibrary?.[0]?.ObjectList?.[0]?.Templates?.[0]?.ObjectList?.[0]?.PlantHierarchyFolder ||
    doc?.ProjectLibrary?.[0]?.ObjectList?.[0]?.Templates?.[0]?.ObjectList?.[0]?.PlantHierarchyFolder ||
    proj?.ObjectList?.[0]?.Templates?.[0]?.ObjectList?.[0]?.PlantHierarchyFolder ||
    [];

  if (!folders.length) {
    throw new Error('No CM/EM types found in XML. Check that this is a valid SIE_LIB.XML file.');
  }

  return folders.map(f => {
    const al  = f.AttributeList?.[0] || {};
    const ol  = f.ObjectList?.[0] || {};
    return {
      name:        attr(f, 'Name'),
      type:        attr(f, 'Type'),
      comment:     childText(al, 'Comment'),
      samplingTime: childText(al, 'SamplingTime'),
      subBlocks:   parseBlocks(ol),
      roles:       parseRoles(ol),
    };
  });
}

module.exports = { parseLibraryXML };
