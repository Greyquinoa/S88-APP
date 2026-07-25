'use strict';

/**
 * Module Parameter Extractor
 * Parses PARAMETER blocks from CFG files and extracts module/channel-level parameters.
 *
 * Example CFG structure:
 *
 * IOSUBSYSTEM 101, IOADDRESS 2, SLOT 1, "6ES7 131-6BH00-0BA0", "DI16 x 24VDC ST V1.0"
 * BEGIN
 *   PARAMETER
 *     DIAGNOSTICS_WIRE_BREAK, "0"
 *     CHANNEL_ACTIVATED, DI , 0, "1"
 *     CHANNEL_ACTIVATED, DI , 1, "1"
 *     ...
 *     INPUT_DELAY, DI , 0, "3.2_MS"
 * END
 */

class ModuleParameterExtractor {
  constructor() {
    this.parameterMap = new Map();
  }

  /**
   * Extract all parameters from a CFG text
   * @param {string} cfgText - Raw CFG file content
   * @returns {Array} Array of extracted parameters with module context
   */
  extractAllParameters(cfgText) {
    const parameters = [];
    const moduleBlocks = this.findModuleBlocks(cfgText);

    moduleBlocks.forEach((block) => {
      const blockParams = this.parseParameterBlock(block.paramText, block.context);
      parameters.push(...blockParams);
    });

    // Debug: log what we found
    if (moduleBlocks.length > 0) {
      console.log(`[ModuleParameterExtractor] Found ${moduleBlocks.length} module blocks with ${parameters.length} total parameters`);
      moduleBlocks.forEach((b, i) => {
        console.log(`  [${i}] orderNo="${b.orderNo}" displayName="${b.displayName}"`);
      });
    }

    return parameters;
  }

  /**
   * Find all PARAMETER blocks that come right after module declarations (SLOT/IOADDRESS)
   * Then correlate them back to their module based on context.
   * @private
   */
  findModuleBlocks(cfgText) {
    const blocks = [];

    // Strategy: Find all PARAMETER blocks, then work backward to find which module they belong to
    const paramRegex = /PARAMETER\s+([\s\S]*?)\nEND(?=\s*\n(?:IOSUBSYSTEM|RACK|$|\Z))/gim;

    let paramMatch;
    while ((paramMatch = paramRegex.exec(cfgText)) !== null) {
      const paramText = paramMatch[1];
      const paramStart = paramMatch.index;

      // Work backward from this parameter block to find the module declaration
      const beforeParam = cfgText.substring(0, paramStart);

      // Find the LAST IOSUBSYSTEM or RACK declaration before this PARAMETER
      // Use a longer lookback window to be safe
      const searchStart = Math.max(0, beforeParam.length - 2000);
      const recentText = beforeParam.substring(searchStart);

      // Find all module declarations in the recent text
      let lastModuleMatch = null;
      const moduleRegex = /^(IOSUBSYSTEM|RACK)\s+([^\n]*?"([^"]+)"\s*"([^"]+)")[^\n]*$/gim;
      let m;
      while ((m = moduleRegex.exec(recentText)) !== null) {
        lastModuleMatch = m;
      }

      if (lastModuleMatch) {
        const moduleType = lastModuleMatch[1];
        const header = lastModuleMatch[2];
        const orderNo = lastModuleMatch[3];
        const displayName = lastModuleMatch[4];

        blocks.push({
          moduleType,
          header,
          orderNo,
          displayName,
          paramText,
          context: { orderNo, displayName }
        });
      }
    }

    return blocks;
  }

  /**
   * Parse a PARAMETER block text and extract all parameters
   * @private
   */
  parseParameterBlock(paramText, context) {
    const parameters = [];

    // Match lines like:
    // DIAGNOSTICS_WIRE_BREAK, "0"
    // CHANNEL_ACTIVATED, DI , 0, "1"
    // INPUT_DELAY, DI , 0, "3.2_MS"
    // POTENTIAL_GROUP, "NEW_GROUP"

    const lines = paramText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));

    lines.forEach((line, idx) => {
      const param = this.parseSingleParameter(line, context);
      if (param) {
        param.sort_order = idx;
        parameters.push(param);
      }
    });

    return parameters;
  }

  /**
   * Parse a single parameter line
   * @private
   * @returns {Object|null} Parsed parameter or null if not matched
   *
   * Parameter names in real CFG files can be UPPER_CASE (DIAGNOSTICS_WIRE_BREAK),
   * mixed-case (Option_Handling, RESET_SWITCH_ENABLE), or quoted TID strings
   * ("TID_Para_20051 PRDIndex 1052 DataID 0"). Channel names are DI/DO/AI/AO.
   */
  parseSingleParameter(line, context) {
    // Remove trailing comma if present
    line = line.replace(/,\s*$/, '').trim();
    if (!line) return null;

    // Pattern 1: CHANNEL-LEVEL PARAMETER (check FIRST — most specific)
    // CHANNEL_ACTIVATED, DI , 0, "1"
    // INPUT_DELAY, DI , 0, "3.2_MS"
    // MEASURING_TYPE, AI , 0, "CURRENT_(2-WIRE_TRANSDUCER)"
    const channelParamRegex = /^([A-Za-z_][\w]*)\s*,\s*(DI|DO|AI|AO|DQ)\s*,\s*(\d+)\s*,\s*"([^"]*)"$/;
    const channelMatch = channelParamRegex.exec(line);
    if (channelMatch) {
      return {
        ...context,
        parameter_name: channelMatch[1],
        channel_type: channelMatch[2], // DI, DO, AI, AO
        channel_no: parseInt(channelMatch[3], 10),
        parameter_value: channelMatch[4],
        parameter_type: 'channel'
      };
    }

    // Pattern 2: MODULE-LEVEL PARAMETER (name, "value")
    // DIAGNOSTICS_WIRE_BREAK, "0"
    // POTENTIAL_GROUP, "NEW_GROUP"
    // Option_Handling, "0"
    // "TID_Para_20051 PRDIndex 1052 DataID 0", "0"   (quoted param name)
    const simpleParamRegex = /^(?:"([^"]+)"|([A-Za-z_][\w]*))\s*,\s*"([^"]*)"$/;
    const simpleMatch = simpleParamRegex.exec(line);
    if (simpleMatch) {
      const name = simpleMatch[1] || simpleMatch[2];
      // Metadata params are internal version/length markers; everything else is module-level
      const isMeta = /^(VERSION_HIGH|VERSION_LOW|VERSION|BLOCK_LENGTH|LENGTH_OF_A_FOLLOWING_CHANNEL_PARAMETER_BLOCK)$/i.test(name);
      return {
        ...context,
        parameter_name: name,
        parameter_value: simpleMatch[3],
        channel_no: null,
        parameter_type: isMeta ? 'metadata' : 'module'
      };
    }

    // If nothing matched, return null (skip BEGIN/END and unrecognized lines)
    return null;
  }

  /**
   * Organize parameters by module context for database insertion
   * @param {Array} parameters - Raw extracted parameters
   * @returns {Map} Map of module context → parameters array
   */
  organizeByModule(parameters) {
    const organized = new Map();

    parameters.forEach((param) => {
      const key = `${param.orderNo}|${param.displayName}`;
      if (!organized.has(key)) {
        organized.set(key, {
          orderNo: param.orderNo,
          displayName: param.displayName,
          parameters: []
        });
      }
      organized.get(key).parameters.push(param);
    });

    return organized;
  }

  /**
   * Extract parameters from a single module block (for direct DB insertion)
   * Called during CFG import to link parameters to hw_signal records
   */
  extractModuleParams(moduleOrderNo, paramText) {
    if (!paramText || !paramText.trim()) return [];

    const lines = paramText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    const params = [];

    lines.forEach((line, idx) => {
      const param = this.parseSingleParameter(line, { orderNo: moduleOrderNo });
      if (param) {
        param.sort_order = idx;
        params.push(param);
      }
    });

    return params;
  }

  /**
   * Parse a catalogue template's param_template text into structured parameter rows.
   * The param_template is the PARAMETER-block body already extracted by
   * cfgCatalogueParser (each line prefixed with 2 spaces, no PARAMETER/END keywords).
   *
   * @param {string} paramTemplate - The param_template text stored on hw_module_templates
   * @returns {Array} Parameter objects ready for ModuleParameterDb.insertModuleParameters
   */
  parseParamTemplate(paramTemplate) {
    if (!paramTemplate || !paramTemplate.trim()) return [];

    const lines = paramTemplate.split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^(PARAMETER|BEGIN|END)\b/i.test(l));

    const params = [];
    lines.forEach((line, idx) => {
      const param = this.parseSingleParameter(line, {});
      if (param) {
        param.sort_order = idx;
        params.push(param);
      }
    });

    return params;
  }

  /**
   * Build a summary of what will be extracted
   */
  summarize(parameters) {
    const summary = {
      total_parameters: parameters.length,
      module_params: 0,
      channel_params: 0,
      metadata_params: 0,
      unique_param_names: new Set(),
      modules_affected: new Set()
    };

    parameters.forEach((p) => {
      if (p.parameter_type === 'module') summary.module_params++;
      if (p.parameter_type === 'channel') summary.channel_params++;
      if (p.parameter_type === 'metadata') summary.metadata_params++;
      summary.unique_param_names.add(p.parameter_name);
      summary.modules_affected.add(`${p.orderNo} (${p.displayName})`);
    });

    return {
      ...summary,
      unique_param_names: Array.from(summary.unique_param_names).sort(),
      modules_affected: Array.from(summary.modules_affected).sort()
    };
  }
}

module.exports = ModuleParameterExtractor;
