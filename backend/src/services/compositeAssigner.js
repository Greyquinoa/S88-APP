// services/compositeAssigner.js — Match extracted CMs to existing Composite CM Types
'use strict';

/**
 * Find best-matching Composite CM Types for extracted CM types.
 * Strict mode: only accept matches with confidence >= threshold (default 0.8).
 *
 * Input:
 *   - extractedCms: string[] of CM type names from PCS7 export
 *   - composites: { compositeId: { name, members, connections } } from loadExistingComposites
 *   - confidenceThreshold: number (0-1), default 0.8
 *
 * Output:
 *   - { assignment: { compositeId: compositeTemplate }, confidence: number, warnings: [] }
 *   - OR throws error if no match reaches threshold
 */
function findCompositeMatches(extractedCms, composites, confidenceThreshold = 0.8) {
  const { scoreCompositeMatch } = require('./pcs7UnitImporter');
  const scores = [];

  // Score each composite against the extracted CM list
  for (const [compositeId, template] of Object.entries(composites)) {
    const score = scoreCompositeMatch(extractedCms, template);
    scores.push({
      compositeId: parseInt(compositeId, 10),
      name: template.name,
      ...score,
    });
  }

  // Sort by confidence descending
  scores.sort((a, b) => b.confidence - a.confidence);

  if (scores.length === 0) {
    throw new Error('No Composite CM Types defined in database');
  }

  const bestMatch = scores[0];

  if (bestMatch.confidence < confidenceThreshold) {
    const error = new Error('Composite assignment failed strict validation');
    error.scores = scores;
    error.threshold = confidenceThreshold;
    throw error;
  }

  const warnings = [];
  if (bestMatch.missingMembers.length > 0) {
    warnings.push(`Missing CM types: ${bestMatch.missingMembers.join(', ')}`);
  }
  if (bestMatch.extraMembers.length > 0) {
    warnings.push(`Unexpected CM types in export: ${bestMatch.extraMembers.join(', ')}`);
  }

  return {
    assignment: {
      compositeId: bestMatch.compositeId,
      compositeName: bestMatch.name,
      memberCount: bestMatch.matches.length,
      connectionCount: composites[bestMatch.compositeId].connections.length,
    },
    confidence: bestMatch.confidence,
    warnings,
    allScores: scores,
  };
}

/**
 * Build unit type member and connection entries from composite assignment.
 * Does NOT create Composite CM Types (assumes they already exist).
 *
 * Input:
 *   - assignment: { compositeId, compositeName }
 *   - interconnections: [{ from, fromVar, to, toVar, ... }]
 *   - aliasPrefix: string (optional, e.g., "MEMBER_")
 *
 * Output:
 *   {
 *     unitMembers: [{ alias, compositeId, hierarchyFolder, isPrimary, sortOrder }],
 *     connections: [{ fromAlias, fromVar, toAlias, toVar, ... }]
 *   }
 */
function buildUnitMemberStructure(assignment, interconnections = [], aliasPrefix = 'MEMBER_') {
  // For now, single composite assignment = single unit member
  // Future: support multiple composite assignments in one unit

  const alias = `${aliasPrefix}${assignment.compositeId}`;

  const unitMembers = [
    {
      alias,
      compositeCmId: assignment.compositeId,
      compositeName: assignment.compositeName,
      hierarchyFolder: 'CM',
      isPrimary: 1,
      sortOrder: 0,
    },
  ];

  // Convert interconnections to unit-level aliases
  // (Within-composite connections are already stored in composite_cm_connections)
  const unitConnections = interconnections
    .filter(conn => conn.fromAlias && conn.toAlias) // Only unit-level wiring
    .map(conn => ({
      fromAlias: conn.fromAlias,
      fromSubIdx: conn.fromSubIdx || 0,
      fromVarName: conn.fromVar,
      toAlias: conn.toAlias,
      toSubIdx: conn.toSubIdx || 0,
      toVarName: conn.toVar,
      connType: conn.connType || 'interconnection',
      staticValue: conn.staticValue || null,
    }));

  return {
    unitMembers,
    connections: unitConnections,
  };
}

/**
 * Validate that all extracted CM types are recognized and mappable.
 * Throws if validation fails.
 *
 * Input:
 *   - extractedCms: string[]
 *   - db: database connection
 */
async function validateCmTypesExist(extractedCms, db) {
  const missing = [];

  for (const cmName of extractedCms) {
    const row = await db.prepare('SELECT id FROM lib_cm_types WHERE name = ?').get(cmName);
    if (!row) {
      missing.push(cmName);
    }
  }

  if (missing.length > 0) {
    throw new Error(`CM types not found in library: ${missing.join(', ')}`);
  }
}

module.exports = {
  findCompositeMatches,
  buildUnitMemberStructure,
  validateCmTypesExist,
};
