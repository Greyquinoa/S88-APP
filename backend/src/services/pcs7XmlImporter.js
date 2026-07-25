// services/pcs7XmlImporter.js — Extract CM types and interconnections from PCS7 XML export
'use strict';

/**
 * Parse PCS7 XML export to extract CM type instances and their interconnections.
 *
 * PCS7 XML structure (SimaticML):
 * - ControlModule and EquipmentModule elements define instances
 * - Each has attributes pointing to library types (CM_AO, EM_REACTOR, etc)
 * - InterconnectionSource elements define signal routing
 */
function extractCmTypesFromXml(xmlText) {
  const cmInstances = [];  // [{ name, alias, type, kind, stripped }] where kind = 'CM' | 'EM' | 'EPH'
  const interconnections = [];
  const metadata = {
    station: null,
    project: null,
    exportDate: null,
    unitName: null,  // extracted from top-level S88Type=Unit folder
  };

  try {
    // Extract station/project/date info
    const stationMatch = xmlText.match(/<Station[^>]*Name="([^"]+)"/i);
    if (stationMatch) metadata.station = stationMatch[1];

    const projectMatch = xmlText.match(/<Project[^>]*Name="([^"]+)"/i);
    if (projectMatch) metadata.project = projectMatch[1];

    // Extract unit name and find ONLY instances INSIDE the Unit folder.
    // The rule: only instances with the unit name prefix in their name get extracted.
    let unitContent = xmlText;  // search space; narrowed to just the unit folder

    // Find the PlantHierarchyFolder that has <S88Type>Unit</S88Type>
    // Strategy: search for <S88Type>Unit</S88Type> first, then backtrack to find its
    // containing <PlantHierarchyFolder> opening tag.
    const s88Match = /<S88Type>Unit<\/S88Type>/i.exec(xmlText);
    if (s88Match) {
      // Backtrack from S88Type to find the last <PlantHierarchyFolder before it
      const s88Pos = s88Match.index;
      const beforeS88 = xmlText.substring(0, s88Pos);
      let unitStart = beforeS88.lastIndexOf('<PlantHierarchyFolder');

      if (unitStart !== -1) {
        // Extract the unit name from the opening tag
        const openTagEnd = xmlText.indexOf('>', unitStart);
        const openTag = xmlText.substring(unitStart, openTagEnd + 1);
        const nameMatch = /Name="([^"]+)"/.exec(openTag);
        if (nameMatch) {
          metadata.unitName = nameMatch[1];

          // Find the closing </PlantHierarchyFolder> that closes this unit folder.
          // Walk from the opening tag and count nesting depth.
          let depth = 0;
          let unitEnd = -1;
          let i = unitStart;
          while (i < xmlText.length) {
            if (xmlText.substr(i, 20).startsWith('<PlantHierarchyFolder')) {
              depth++;
              i = xmlText.indexOf('>', i) + 1;
            } else if (xmlText.substr(i, 21).startsWith('</PlantHierarchyFolder>')) {
              depth--;
              if (depth === 0) {
                unitEnd = i + 21;
                break;
              }
              i += 21;
            } else {
              i++;
            }
          }
          if (unitEnd > 0) unitContent = xmlText.substring(unitStart, unitEnd);
        }
      }
    }

    // PCS7 XML represents each CM/EM instance as a PlantHierarchyFolder:
    //   <PlantHierarchyFolder Name="NIF_React01_XV10" Type="ControlModule" ID="...">
    //     <AttributeList>
    //       <ProcessTagType>CM_AO</ProcessTagType>   <-- the library CM/EM TYPE name
    //     </AttributeList>
    //     <ObjectList>
    //       <PlantHierarchyFolder Name="Block" Type="ControlModule" ...>   <-- nested block
    //         <ProcessTagType>CM_AO\Block</ProcessTagType>   <-- contains "\" (skip)
    //
    // We extract ONLY instances WITHIN THE UNIT CONTENT. Each instance's folder
    // is recognized by Type="ControlModule|EquipmentModule|EquipmentPhase" and has
    // a ProcessTagType child with no backslash (distinguishing it from block folders).

    const folderRegex = /<PlantHierarchyFolder\s+Name="([^"]+)"\s+Type="(ControlModule|EquipmentModule|EquipmentPhase)"[^>]*>/gi;
    let match;
    const processedInstances = new Set();
    const idToInstance = new Map();  // folder ID → instance name (for role TargetID resolution)

    // Search the ENTIRE XML but filter to only instances within the unit:
    // if a unit name was found, only include instances with that prefix; otherwise include all.
    while ((match = folderRegex.exec(xmlText)) !== null) {
      const instanceName = match[1];
      const folderType = match[2];  // "ControlModule" | "EquipmentModule" | "EquipmentPhase"
      const afterTag = folderRegex.lastIndex;

      // Extract folder ID from the match (parse the opening tag for ID attribute)
      const idMatch = /ID="([^"]+)"/.exec(match[0]);
      const folderId = idMatch ? idMatch[1] : null;

      // The first <ProcessTagType> after this opening tag belongs to this folder
      // (its own AttributeList comes before any nested folder's AttributeList).
      const ptMatch = /<ProcessTagType>([^<]+)<\/ProcessTagType>/i.exec(
        xmlText.slice(afterTag, afterTag + 4000)
      );
      if (!ptMatch) continue;

      const processTagType = ptMatch[1].trim();

      // Block-level folders carry "TYPE\Block" — skip them; keep only instances.
      if (processTagType.includes('\\')) continue;

      if (processedInstances.has(instanceName)) continue;

      let kind = 'CM';
      if (folderType === 'EquipmentModule') kind = 'EM';
      else if (folderType === 'EquipmentPhase') kind = 'EPH';

      // Compute alias: strip unit name pattern ONLY for instances inside the unit
      // Instances outside the unit keep their original names as aliases
      let alias = instanceName;
      let stripped = '';
      let isInsideUnit = true;

      if (metadata.unitName) {
        const unitPrefix = `${metadata.unitName}_`;
        const isInside = instanceName.includes(unitPrefix);
        isInsideUnit = isInside;

        if (isInside) {
          // Inside unit: strip the unit name prefix
          stripped = unitPrefix;
          alias = instanceName.replace(unitPrefix, '');
        }
        // Outside unit: keep original name as alias (stripped stays '')
      }

      processedInstances.add(instanceName);
      if (folderId) idToInstance.set(folderId, { name: instanceName, alias, kind });
      cmInstances.push({
        name: instanceName,
        alias,
        type: processTagType,
        kind,
        stripped,  // what was removed from instance name to create alias
        folderId,
      });
    }

    // Extract role assignments from EM/EPH instance folders WITHIN THE UNIT.
    // Each role lives in an <EquipmentModuleAssignment> or <ControlModuleAssignment>:
    //   <EquipmentModuleAssignment ID="...">
    //     <AttributeList><Role>MTX_C</Role></AttributeList>
    //     <LinkList><AssignedEquipmentModule TargetID="#<folderId>"/></LinkList>
    //   </EquipmentModuleAssignment>
    const roleAssignments = [];  // [{ ownerInstance, ownerAlias, role, targetInstance, targetAlias }]
    const assignRegex = /<(EquipmentModuleAssignment|ControlModuleAssignment)\s+[^>]*>([\s\S]*?)<\/\1>/gi;
    let aMatch;
    while ((aMatch = assignRegex.exec(unitContent)) !== null) {
      const block = aMatch[2];
      const roleMatch = /<Role>([^<]+)<\/Role>/i.exec(block);
      const targetMatch = /<Assigned(?:Equipment|Control)Module\s+TargetID="#?([^"]+)"/i.exec(block);
      if (!roleMatch) continue;

      const role = roleMatch[1].trim();
      const targetId = targetMatch ? targetMatch[1] : null;
      const target = targetId ? idToInstance.get(targetId) : null;

      // Find which instance folder OWNS this assignment (the nearest enclosing
      // instance folder before this assignment's position).
      const assignPos = aMatch.index;
      let owner = null;
      for (const cm of cmInstances) {
        if (!cm.folderId) continue;
        const ownerOpenPos = unitContent.indexOf(`ID="${cm.folderId}"`);
        if (ownerOpenPos !== -1 && ownerOpenPos < assignPos) {
          if (!owner || ownerOpenPos > owner._pos) {
            owner = { ...cm, _pos: ownerOpenPos };
          }
        }
      }

      roleAssignments.push({
        ownerInstance: owner ? owner.name : null,
        ownerAlias: owner ? owner.alias : null,
        role,
        targetInstance: target ? target.name : null,
        targetAlias: target ? target.alias : null,
      });
    }

    metadata.roleAssignments = roleAssignments;

    // ── Interconnections: signal routing between CM/EM instances ──
    // Real PCS7 format: an <InterconnectionSource> tag lives INSIDE a consumer
    // ControlVariable's <LinkList>, and its TargetID points at the PRODUCER
    // variable elsewhere in the document:
    //   <ControlVariable Name="CmndUnit" ID="#consumerVarId">   (the target/consumer)
    //     <LinkList>
    //       <InterconnectionSource TargetID="#producerVarId"/>  (the source/producer)
    //     </LinkList>
    //   </ControlVariable>
    // So: producer(source).var  →  consumer(target).var
    //
    // Variables are nested many levels deep (CM → block folder → ControlVariable),
    // so we resolve each variable ID to its OWNING TOP-LEVEL instance (from
    // cmInstances) by span containment, ignoring intermediate block folders.

    // 1. Index every ControlVariable: ID → { name, pos }
    const varInfoById = new Map();  // varId → { name, pos }
    {
      const varRegex = /<ControlVariable\s+Name="([^"]+)"\s+Type="[^"]*"\s+ID="([^"]+)"/gi;
      let vm;
      while ((vm = varRegex.exec(unitContent)) !== null) {
        varInfoById.set(vm[2], { name: vm[1], pos: vm.index });
      }
    }

    // 2. Build top-level instance spans [start, end) within unitContent so we can
    //    map any position → its owning instance. We compute each instance folder's
    //    span by matching balanced PlantHierarchyFolder open/close from its opening.
    const instanceSpans = [];  // { instance, start, end }
    for (const cm of cmInstances) {
      if (!cm.folderId) continue;
      const openIdx = unitContent.indexOf(`ID="${cm.folderId}"`);
      if (openIdx === -1) continue;
      // Back up to the start of this opening tag
      const tagStart = unitContent.lastIndexOf('<PlantHierarchyFolder', openIdx);
      if (tagStart === -1) continue;
      // Walk forward counting nested PlantHierarchyFolder open/close to find matching close
      let depth = 0;
      let i = tagStart;
      let spanEnd = unitContent.length;
      while (i < unitContent.length) {
        if (unitContent.startsWith('<PlantHierarchyFolder', i)) {
          depth++;
          i = unitContent.indexOf('>', i);
          if (i === -1) break;
          i++;
        } else if (unitContent.startsWith('</PlantHierarchyFolder>', i)) {
          depth--;
          if (depth === 0) { spanEnd = i; break; }
          i += 23;
        } else {
          i++;
        }
      }
      instanceSpans.push({ instance: cm, start: tagStart, end: spanEnd });
    }
    // Sort by start ascending; for containment we pick the SMALLEST span that
    // contains the position (deepest instance), though top-level instances don't
    // nest inside each other so any containing span is correct.
    instanceSpans.sort((a, b) => a.start - b.start);

    const ownerInstanceForPos = (pos) => {
      let best = null;
      for (const s of instanceSpans) {
        if (pos >= s.start && pos < s.end) {
          if (!best || (s.end - s.start) < (best.end - best.start)) best = s;
        }
      }
      return best ? best.instance : null;
    };

    // 3. For each InterconnectionSource, the enclosing ControlVariable is the
    //    consumer (target); TargetID is the producer (source).
    const icRegex = /<InterconnectionSource\s+TargetID="#?([^"]+)"\s*\/>/gi;
    while ((match = icRegex.exec(unitContent)) !== null) {
      const producerVarId = match[1];
      const tagPos = match.index;

      // Consumer variable = the ControlVariable whose opening tag is nearest
      // BEFORE this InterconnectionSource tag.
      const consumerOpen = unitContent.lastIndexOf('<ControlVariable', tagPos);
      if (consumerOpen === -1) continue;
      const consumerIdMatch = /ID="([^"]+)"/.exec(unitContent.slice(consumerOpen, tagPos));
      const consumerVarId = consumerIdMatch ? consumerIdMatch[1] : null;
      if (!consumerVarId) continue;

      const producer = varInfoById.get(producerVarId);
      const consumer = varInfoById.get(consumerVarId);
      if (!producer || !consumer) continue;

      const producerInstance = ownerInstanceForPos(producer.pos);
      const consumerInstance = ownerInstanceForPos(consumer.pos);
      if (!producerInstance || !consumerInstance) continue;

      // producer → consumer  (data flows from producer's OUT to consumer's IN)
      interconnections.push({
        fromInstance: producerInstance.name,
        fromInstanceAlias: producerInstance.alias,
        fromVarName: producer.name,
        toInstance: consumerInstance.name,
        toInstanceAlias: consumerInstance.alias,
        toVarName: consumer.name,
      });
    }

  } catch (err) {
    console.error('[PCS7 XML Parse] Error:', err.message);
  }

  return {
    cmInstances,  // All CM/EM/EPH instances found
    cmTypes: [...new Set(cmInstances.map(c => c.type))],  // Unique type names
    interconnections,
    metadata,
    source: 'xml',
  };
}

/**
 * Group CM instances into likely Composite CM Types based on naming patterns.
 *
 * Heuristics:
 * 1. Shared prefix: "AO_01", "AO_02" → likely one Composite "AO_GROUP"
 * 2. Interconnected group: CMs with many connections between them → one Composite
 * 3. Isolation: Single CM with no connections → separate Composite
 */
function inferCompositeGrouping(cmInstances, interconnections) {
  const groups = {};
  const connections = new Map();

  // Build connection graph
  for (const conn of interconnections) {
    if (!connections.has(conn.fromInstance)) connections.set(conn.fromInstance, []);
    if (!connections.has(conn.toInstance)) connections.set(conn.toInstance, []);
    connections.get(conn.fromInstance).push(conn.toInstance);
  }

  // Group by name prefix (e.g., "CM_AO_01", "CM_AO_02" → "CM_AO")
  for (const instance of cmInstances) {
    let groupName = instance;

    // Try to extract base name (remove trailing numbers)
    const baseMatch = instance.match(/^(.+?)_?\d+$/);
    if (baseMatch) {
      groupName = baseMatch[1];
    }

    if (!groups[groupName]) {
      groups[groupName] = [];
    }
    groups[groupName].push(instance);
  }

  return groups;
}

module.exports = {
  extractCmTypesFromXml,
  inferCompositeGrouping,
};
