'use strict';

const express = require('express');
const router = express.Router();

const ModuleParameterDb = require('../services/moduleParameterDb');

/**
 * Module Parameters API
 * Parameters are linked to hw_module_templates (module TYPES) via template_id.
 */

/**
 * GET /api/module-parameters/templates/:id
 * Get all parameters for a specific module template
 */
router.get('/templates/:id', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const parameters = await ModuleParameterDb.getParametersByTemplate(templateId);
    const stats = await ModuleParameterDb.getParameterStats(templateId);
    res.json({ success: true, templateId, parameters, stats });
  } catch (err) {
    console.error('[ModuleParam] GET parameters error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/module-parameters/templates/:id/grouped
 * Get parameters organized by type (module, channel, metadata)
 */
router.get('/templates/:id/grouped', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const grouped = await ModuleParameterDb.getParametersGrouped(templateId);
    res.json({ success: true, templateId, ...grouped });
  } catch (err) {
    console.error('[ModuleParam] GET grouped parameters error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/module-parameters/templates/:id/export-cfg
 * Export parameters as a CFG PARAMETER block
 */
router.get('/templates/:id/export-cfg', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const paramBlock = await ModuleParameterDb.exportAsParameterBlock(templateId);
    res.setHeader('Content-Type', 'text/plain');
    res.send(paramBlock);
  } catch (err) {
    console.error('[ModuleParam] GET export-cfg error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/module-parameters/templates/:id/channels/:channelNo
 * Get parameters for a specific channel
 */
router.get('/templates/:id/channels/:channelNo', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const channelNo = parseInt(req.params.channelNo, 10);
    const parameters = await ModuleParameterDb.getChannelParameters(templateId, channelNo);
    res.json({ success: true, templateId, channelNo, parameters });
  } catch (err) {
    console.error('[ModuleParam] GET channel parameters error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/module-parameters/by-name/:paramName
 * Get a parameter across all templates
 */
router.get('/by-name/:paramName', async (req, res) => {
  try {
    const paramName = req.params.paramName;
    const parameters = await ModuleParameterDb.getParametersByName(paramName);
    res.json({ success: true, parameterName: paramName, count: parameters.length, parameters });
  } catch (err) {
    console.error('[ModuleParam] GET by-name error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/module-parameters/templates/:id/channel-param
 * Update a channel-level parameter for all channels of a given type
 * Body: { parameter_name, channel_type, parameter_value, spare_value, is_dynamic }
 * Updates all rows matching (template_id, parameter_name, channel_type)
 */
router.patch('/templates/:id/channel-param', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const { parameter_name, channel_type, parameter_value, spare_value, is_dynamic } = req.body;

    if (!parameter_name || !channel_type) {
      return res.status(400).json({ success: false, error: 'parameter_name and channel_type required' });
    }

    const db = require('../db').getDb();

    // Update all rows for this template with matching parameter_name and channel_type
    const result = await db.prepare(`
      UPDATE hw_module_parameters
      SET parameter_value = ?, spare_value = ?, is_dynamic = ?, updated_at = NOW()
      WHERE template_id = ? AND parameter_name = ? AND channel_type = ?
    `).run(
      parameter_value || '',
      spare_value || null,
      !!is_dynamic,
      templateId,
      parameter_name,
      channel_type
    );

    res.json({ success: true, changes: result.rowCount });
  } catch (err) {
    console.error('[ModuleParam] PATCH channel-param error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/module-parameters/templates/:id/module-param
 * Update a module-level parameter value (channel_no IS NULL)
 * Body: { parameter_name, parameter_value }
 */
router.patch('/templates/:id/module-param', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const { parameter_name, parameter_value } = req.body;

    if (!parameter_name) {
      return res.status(400).json({ success: false, error: 'parameter_name required' });
    }

    const changes = await ModuleParameterDb.updateModuleLevelParameter(
      templateId, parameter_name, parameter_value
    );
    res.json({ success: true, changes });
  } catch (err) {
    console.error('[ModuleParam] PATCH module-param error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/module-parameters/templates/:id/visibility
 * Set visibility for one or more parameters (by name)
 * Body: { updates: [{ parameter_name, is_visible }] }
 */
router.patch('/templates/:id/visibility', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const { updates } = req.body;

    if (!Array.isArray(updates)) {
      return res.status(400).json({ success: false, error: 'updates array required' });
    }

    const changes = await ModuleParameterDb.setParameterVisibility(templateId, updates);
    res.json({ success: true, changes });
  } catch (err) {
    console.error('[ModuleParam] PATCH visibility error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
