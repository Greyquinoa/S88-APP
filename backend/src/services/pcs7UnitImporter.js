// services/pcs7UnitImporter.js — Extract CM types and interconnections from CFG/XML
'use strict';

/**
 * Extracts CM types and interconnections from a PCS7 CFG export.
 *
 * Input: Raw CFG text (from STEP7 export)
 * Output: { cmTypes: [], interconnections: [], metadata: {} }
 */

function extractCmTypesFromCfg(cfgText) {
  const lines = cfgText.split(/\r?\n/);
  const cmTypes = new Set();
  const metadata = {
    station: null,
    stationType: null,
    modules: [],
    slots: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Extract station info: STATION S7400 , "AS01"
    if (line.match(/^STATION\s+(\S+)\s*,\s*"([^"]+)"/)) {
      const m = line.match(/^STATION\s+(\S+)\s*,\s*"([^"]+)"/);
      metadata.stationType = m[1];
      metadata.station = m[2];
    }

    // Extract CM type from MODULE_INFO line: MODULE_INFO "TEST_CM_AO" 1 0
    // This is injected during CFG generation from PlantHierarchyFolder XML
    if (line.match(/MODULE_INFO\s+"([^"]+)"/i)) {
      const m = line.match(/MODULE_INFO\s+"([^"]+)"/i);
      const cmTypeName = m[1];
      if (cmTypeName) cmTypes.add(cmTypeName);
    }

    // Alternative: Extract from XML-style CM_Instance tags
    // Example: <CM_Instance name="CM_A01" type_name="CM_AO" />
    if (line.match(/<CM_Instance\s+name="([^"]+)"\s+type_name="([^"]+)"/i)) {
      const m = line.match(/<CM_Instance\s+name="([^"]+)"\s+type_name="([^"]+)"/i);
      const cmTypeName = m[2];
      if (cmTypeName) cmTypes.add(cmTypeName);
    }

    // Extract from MLFB lines (Module ID in CFG)
    // Example: MLFB "6ES7 321-1BH02-0AA0" — not directly useful for CM type names
    // but can be extended for hardware-based grouping later
  }

  return {
    cmTypes: Array.from(cmTypes),
    metadata,
    source: 'cfg',
  };
}

/**
 * Extracts interconnections from generated XML output.
 * Parses <InterconnectionSource> tags to identify signal routing.
 *
 * Input: XML text (from /api/generate output)
 * Output: Array of interconnections
 */
function extractInterconnectionsFromXml(xmlText) {
  const interconnections = [];
  const regex = /<InterconnectionSource\s+TargetID="([^"]+)"/gi;
  let match;

  // Parse TargetID format: e.g., "0000800#1.0.0.1.2"
  // Which refers to a specific control variable in a control module instance
  while ((match = regex.exec(xmlText)) !== null) {
    const targetId = match[1];
    // Extract connection metadata from surrounding context
    // This is a simplified approach; full parsing would need to walk the XML tree
    interconnections.push({
      targetId,
      // Additional parsing would extract from/to details
    });
  }

  return interconnections;
}

/**
 * Load Composite CM Types from database and return their expected member structure.
 * Used to match extracted CMs against existing Composites.
 *
 * Returns: { compositeId: { name, members: [{ cmName, sort_order }], connections } }
 */
async function loadExistingComposites(db) {
  const composites = {};

  const rows = await db.prepare('SELECT id, name FROM composite_cm_types').all();

  for (const comp of rows) {
    const members = await db.prepare(
      'SELECT id, cm_type_name, sort_order FROM composite_cm_members WHERE composite_id = ? ORDER BY sort_order'
    ).all(comp.id);

    const connections = await db.prepare(
      'SELECT from_member_idx, from_var_name, to_member_idx, to_var_name FROM composite_cm_connections WHERE composite_id = ?'
    ).all(comp.id);

    composites[comp.id] = {
      id: comp.id,
      name: comp.name,
      members: members.map(m => ({
        cmTypeName: m.cm_type_name,
        sortOrder: m.sort_order,
      })),
      connections: connections.map(c => ({
        fromMemberIdx: c.from_member_idx,
        fromVar: c.from_var_name,
        toMemberIdx: c.to_member_idx,
        toVar: c.to_var_name,
      })),
    };
  }

  return composites;
}

/**
 * Compare extracted CM list against a specific Composite CM Type template.
 * Score how well they match (for strict mode validation).
 *
 * Returns: { confidence: 0-1, matches: [{ cmName, memberIdx }], missingMembers: [], extraMembers: [] }
 */
function scoreCompositeMatch(extractedCms, compositeTemplate) {
  const extractedSet = new Set(extractedCms);
  const templateCms = compositeTemplate.members.map(m => m.cmTypeName);
  const templateSet = new Set(templateCms);

  const matches = [];
  const missingMembers = [];
  const extraMembers = [];

  // Check which template members were found
  for (let i = 0; i < templateCms.length; i++) {
    if (extractedSet.has(templateCms[i])) {
      matches.push({ cmName: templateCms[i], memberIdx: i });
    } else {
      missingMembers.push(templateCms[i]);
    }
  }

  // Check for extra CMs not in template
  for (const cm of extractedCms) {
    if (!templateSet.has(cm)) {
      extraMembers.push(cm);
    }
  }

  // Confidence calculation:
  // - Exact match: 1.0
  // - Missing non-primary: -0.1 each
  // - Extra CMs: -0.05 each
  let confidence = 1.0;
  if (missingMembers.length > 0) confidence -= 0.15 * missingMembers.length;
  if (extraMembers.length > 0) confidence -= 0.05 * extraMembers.length;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    confidence,
    matches,
    missingMembers,
    extraMembers,
  };
}

module.exports = {
  extractCmTypesFromCfg,
  extractInterconnectionsFromXml,
  loadExistingComposites,
  scoreCompositeMatch,
};
