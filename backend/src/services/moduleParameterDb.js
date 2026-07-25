'use strict';

const { getDb } = require('../db');

/**
 * Database operations for hw_module_parameters.
 * Parameters are linked to hw_module_templates (module TYPES) via template_id.
 */
class ModuleParameterDb {
  /**
   * Insert parameters for a specific module template.
   * @param {number} templateId - ID of the hw_module_templates record
   * @param {Array} parameters - Array of parameter objects
   * @returns {number} Count inserted
   */
  static async insertModuleParameters(templateId, parameters) {
    if (!parameters || !parameters.length) return 0;

    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO hw_module_parameters
        (template_id, parameter_name, parameter_value, channel_type, channel_no, parameter_type, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (template_id, parameter_name, channel_no) DO UPDATE SET
        parameter_value = EXCLUDED.parameter_value,
        channel_type    = EXCLUDED.channel_type,
        parameter_type  = EXCLUDED.parameter_type,
        sort_order      = EXCLUDED.sort_order
    `);

    let count = 0;
    for (const param of parameters) {
      await insert.run(
        templateId,
        param.parameter_name,
        param.parameter_value ?? null,
        param.channel_type ?? null,
        param.channel_no ?? null,
        param.parameter_type || 'module',
        param.sort_order ?? 0
      );
      count++;
    }

    return count;
  }

  /**
   * Get all parameters for a specific template
   * @param {number} templateId
   * @returns {Array} Parameters ordered by sort_order
   */
  static async getParametersByTemplate(templateId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM hw_module_parameters
      WHERE template_id = ?
      ORDER BY sort_order ASC
    `).all(templateId);
  }

  /**
   * Get parameters by name (across all templates)
   * @param {string} parameterName
   * @returns {Array}
   */
  static async getParametersByName(parameterName) {
    const db = getDb();
    return db.prepare(`
      SELECT hmp.*, t.order_no, t.display_name, t.family, t.signal_type
      FROM hw_module_parameters hmp
      JOIN hw_module_templates t ON hmp.template_id = t.id
      WHERE hmp.parameter_name = ?
      ORDER BY t.id, hmp.channel_no
    `).all(parameterName);
  }

  /**
   * Get parameters for a specific channel of a template
   * @param {number} templateId
   * @param {number} channelNo
   * @returns {Array}
   */
  static async getChannelParameters(templateId, channelNo) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM hw_module_parameters
      WHERE template_id = ? AND channel_no = ?
      ORDER BY sort_order ASC
    `).all(templateId, channelNo);
  }

  /**
   * Get all module-level (non-channel) parameters for a template
   * @param {number} templateId
   * @returns {Array}
   */
  static async getModuleLevelParameters(templateId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM hw_module_parameters
      WHERE template_id = ? AND (parameter_type = 'module' OR parameter_type = 'metadata')
      ORDER BY sort_order ASC
    `).all(templateId);
  }

  /**
   * Get parameters grouped by type for a template
   * @param {number} templateId
   * @returns {Object} { moduleLevel: [], channelLevel: [], metadata: [] }
   */
  static async getParametersGrouped(templateId) {
    const db = getDb();
    const all = await db.prepare(`
      SELECT * FROM hw_module_parameters
      WHERE template_id = ?
      ORDER BY parameter_type, sort_order ASC
    `).all(templateId);

    return {
      moduleLevel: all.filter(p => p.parameter_type === 'module'),
      channelLevel: all.filter(p => p.parameter_type === 'channel'),
      metadata: all.filter(p => p.parameter_type === 'metadata')
    };
  }

  /**
   * Update a module-level parameter's value (channel_no IS NULL).
   * @param {number} templateId
   * @param {string} parameterName
   * @param {string} parameterValue
   * @returns {number} rows changed
   */
  static async updateModuleLevelParameter(templateId, parameterName, parameterValue) {
    const db = getDb();
    const result = await db.prepare(`
      UPDATE hw_module_parameters
      SET parameter_value = ?, updated_at = NOW()
      WHERE template_id = ? AND parameter_name = ? AND channel_no IS NULL
    `).run(parameterValue ?? '', templateId, parameterName);
    return result.rowCount;
  }

  /**
   * Set visibility for one or more parameters (by name) of a template.
   * Updates all rows (all channels) matching each parameter_name.
   * @param {number} templateId
   * @param {Array<{parameter_name: string, is_visible: (0|1|boolean)}>} updates
   * @returns {number} total rows changed
   */
  static async setParameterVisibility(templateId, updates) {
    if (!Array.isArray(updates) || updates.length === 0) return 0;
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE hw_module_parameters
      SET is_visible = ?, updated_at = NOW()
      WHERE template_id = ? AND parameter_name = ?
    `);
    const tx = db.transaction(async (rows) => {
      let changed = 0;
      for (const u of rows) {
        const vis = !!u.is_visible;
        const result = await stmt.run(vis, templateId, u.parameter_name);
        changed += result.rowCount;
      }
      return changed;
    });
    return tx(updates);
  }

  /**
   * Delete all parameters for a template (e.g. when re-importing)
   * @param {number} templateId
   * @returns {number} Count deleted
   */
  static async deleteParametersForTemplate(templateId) {
    const db = getDb();
    const rows = await db.prepare('SELECT COUNT(*) as cnt FROM hw_module_parameters WHERE template_id = ?')
      .get(templateId);
    const count = Number(rows?.cnt) || 0;

    await db.prepare('DELETE FROM hw_module_parameters WHERE template_id = ?').run(templateId);
    return count;
  }

  /**
   * Get parameter statistics for a template
   * @param {number} templateId
   * @returns {Object}
   */
  static async getParameterStats(templateId) {
    const db = getDb();
    const stats = await db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN parameter_type = 'module' THEN 1 ELSE 0 END) as module_count,
        SUM(CASE WHEN parameter_type = 'channel' THEN 1 ELSE 0 END) as channel_count,
        SUM(CASE WHEN parameter_type = 'metadata' THEN 1 ELSE 0 END) as metadata_count,
        COUNT(DISTINCT parameter_name) as unique_names,
        COUNT(DISTINCT channel_no) as channel_diversity
      FROM hw_module_parameters
      WHERE template_id = ?
    `).get(templateId);

    if (!stats) {
      return {
        total: 0, module_count: 0, channel_count: 0,
        metadata_count: 0, unique_names: 0, channel_diversity: 0
      };
    }
    return {
      total: Number(stats.total) || 0,
      module_count: Number(stats.module_count) || 0,
      channel_count: Number(stats.channel_count) || 0,
      metadata_count: Number(stats.metadata_count) || 0,
      unique_names: Number(stats.unique_names) || 0,
      channel_diversity: Number(stats.channel_diversity) || 0,
    };
  }

  /**
   * Export parameters for a template in CFG PARAMETER-block format
   * @param {number} templateId
   * @returns {string} CFG-format PARAMETER block
   */
  static async exportAsParameterBlock(templateId) {
    const grouped = await this.getParametersGrouped(templateId);
    const lines = ['PARAMETER'];

    grouped.moduleLevel.forEach((p) => {
      lines.push(`  ${p.parameter_name}, "${p.parameter_value}"`);
    });
    grouped.metadata.forEach((p) => {
      lines.push(`  ${p.parameter_name}, "${p.parameter_value}"`);
    });

    if (grouped.channelLevel.length > 0) {
      const byChannel = {};
      grouped.channelLevel.forEach((p) => {
        const ch = p.channel_no;
        if (!byChannel[ch]) byChannel[ch] = [];
        byChannel[ch].push(p);
      });
      Object.keys(byChannel)
        .sort((a, b) => parseInt(a) - parseInt(b))
        .forEach((ch) => {
          byChannel[ch].forEach((p) => {
            lines.push(`  ${p.parameter_name}, ${p.channel_type} , ${p.channel_no}, "${p.parameter_value}"`);
          });
        });
    }

    lines.push('END');
    return lines.join('\n');
  }
}

module.exports = ModuleParameterDb;
