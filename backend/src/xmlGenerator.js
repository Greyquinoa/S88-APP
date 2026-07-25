// src/xmlGenerator.js — SimaticML XML generator
// Based on Ratio Exp_XML_CM VBA reference implementation
// Moved from frontend to backend so the generation logic is centralised
'use strict';

// ── ID generator ──────────────────────────────────────────────────────────────
let _ctr = 0x00400000;
const _h8     = () => (_ctr++).toString(16).padStart(8, '0').toUpperCase();
const mkBlock = () => `DT0003006D${_h8()}`;
const mkVar   = () => `DT0003006E${_h8()}`;
const mkMsg   = () => `DT0003003E${_h8()}`;
const appId   = id => 'DT0000' + id.slice(6);
const resetCtr = () => { _ctr = 0x00400000; resetIOTagCtr(); };

// ── IOTag ID generator ────────────────────────────────────────────────────────
// Generate IOTag IDs following PCS7 convention: OD00113002:{unique hex}:{parent type}:{parent hex}
let _iotagCtr = 0x00000000;
const mkIOTag = (parentTypeHex, parentIdHex) => {
  const unique = (_iotagCtr++).toString(16).padStart(8, '0').toUpperCase();
  return `OD00113002:${unique}:${parentTypeHex}:${parentIdHex}`;
};
const resetIOTagCtr = () => { _iotagCtr = 0x00000000; };

// ── Fixed project/hardware IDs (fallback defaults) ────────────────────────────
const FX_DEFAULT = {
  PROJ:  'OD00112001:00000220:00000000:00000000',
  DEV:   'OD0014109A:00000001:00112001:000000A7',
  RACK:  'OD0024112A:00000001:0014109A:00000001',
  CPU:   'OD0024177E:00000002:0024112A:00000001',
  IOTAG: 'OD00113001:00006407:00000000:00000000',
  PC:    'OD01101071:00000145:00000000:00000000',
};

// Build a FX object merged with live project config extracted from a PCS7 export.
// projectConfig is the row from project_config (may be null → use defaults everywhere).
function buildFX(projectConfig) {
  if (!projectConfig) return FX_DEFAULT;
  return {
    PROJ:  projectConfig.project_id_val  || FX_DEFAULT.PROJ,
    DEV:   projectConfig.device_id       || FX_DEFAULT.DEV,
    RACK:  FX_DEFAULT.RACK,   // not extracted by the parser — keep default
    CPU:   projectConfig.cpu_id          || FX_DEFAULT.CPU,
    IOTAG: FX_DEFAULT.IOTAG,  // not exposed in exports
    PC:    projectConfig.process_cell_id || FX_DEFAULT.PC,
  };
}

// ── Fallback values when linked block is absent ───────────────────────────────
const FALLBACKS = {
  'AIF_FRONT.ForceClose': '0',
  'AIF_FRONT.ForceOpen':  '0',
  'AIF_FRONT.Interlock':  '1',
  'AIF_FRONT.MV_Progr':   '0.0',
  'AIF_FRONT.Protection': '1',
  'AIF_FRONT.StepNo':     '16#00000000',
  'AIF_FRONT.StatBatch':  null,
  'AIF_FRONT.StatRoute':  null,
  'V.Intlock':            '1',
  'V.Protect':            '1',
  'V.SelFp2':             null,
  'YC_SCALE.INPUT_HR':    '100.0',
  'YC_SCALE.INPUT_LR':    '0.0',
};

// ── Message text overrides (English, from reference AS01_v1.XML) ──────────────
const MSG_OVERRIDES = {
  'CM_AO:V:I_MsgEvId1_SIG1': { cls: 'PLC process control message - Failure', event: '$$BlockComment$$ Feedback error',                                              prio: '6',  ack: true  },
  'CM_AO:V:I_MsgEvId1_SIG2': { cls: 'Alarm - high',                          event: '@8X%t#Criticality@$$BlockComment$$ ER - High alarm limit violated',           prio: '7',  ack: true  },
  'CM_AO:V:I_MsgEvId1_SIG3': { cls: 'Alarm - low',                           event: '@8X%t#Criticality@$$BlockComment$$ ER - Low alarm limit violated',            prio: '7',  ack: true  },
  'CM_AO:V:I_MsgEvId1_SIG4': { cls: 'Warning - high',                        event: '@8X%t#Criticality@$$BlockComment$$ Rbk - High warning limit violated',        prio: '7',  ack: true  },
  'CM_AO:V:I_MsgEvId1_SIG5': { cls: 'Warning - low',                         event: '@8X%t#Criticality@$$BlockComment$$ Rbk - Low warning limit violated',         prio: '7',  ack: true  },
  'CM_AO:V:I_MsgEvId1_SIG6': { cls: 'Alarm - high',                          event: '@8X%t#Criticality@$$BlockComment$$ External error has occurred',               prio: '6',  ack: true  },
  'CM_AO:V:I_MsgEvId1_SIG7': { cls: 'Operational Message - Without Acknowledgment', event: '$$BlockComment$$ Bypass active',                                       prio: '11', ack: false },
  'CM_AO:V:I_MsgEvId1_SIG8': { cls: 'PLC process control message - Failure',  event: '$$BlockComment$$ Protection active',                                         prio: '7',  ack: true  },
};

// ── XML escape helper (module-level so b.raw() callers can use it too) ───────
const esc = s => (s || '').toString()
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── XML builder (mirrors Ratio Add_XML_* helpers) ─────────────────────────────
function makeBuilder() {
  const lines = [];
  let level = 0;
  const T   = n => '\t'.repeat(n);

  return {
    open(tag, ...pairs) {
      let attrs = '';
      for (let i = 0; i < pairs.length; i += 2)
        if (pairs[i] && pairs[i + 1] !== undefined && pairs[i + 1] !== '')
          attrs += ` ${pairs[i]}="${esc(pairs[i + 1])}"`;
      lines.push(`${T(level)}<${tag}${attrs}>`);
      level++;
    },
    close(tag) {
      level--;
      lines.push(`${T(level)}</${tag}>`);
    },
    par(tag, value) {
      if (value !== null && value !== undefined && value !== '')
        lines.push(`${T(level)}<${tag}>${esc(value)}</${tag}>`);
    },
    attr(tag, ...pairs) {
      let attrs = '';
      for (let i = 0; i < pairs.length; i += 2)
        if (pairs[i] && pairs[i + 1] !== undefined && pairs[i + 1] !== '')
          attrs += ` ${pairs[i]}="${esc(pairs[i + 1])}"`;
      lines.push(`${T(level)}<${tag}${attrs}/>`);
    },
    raw(text) { lines.push(text); },
    result()  { return lines.join('\r\n'); },
  };
}

// ── Matrix instance emit ─────────────────────────────────────────────────────
// Generates the IEMT_MTX nested XML structure matching the Python matrix_generator output.
// matrixDef: { instanceName, samplingTime, columns: string[], modes: [{mode_nr, mode_name, cells:{col:val}}] }
// Returns an array of raw XML lines (baseline indent = 5 tabs, matching emitInstanceLines).
function emitMatrixInstanceLines(matrixDef, counters, preAllocatedId, fx) {
  fx = fx || FX_DEFAULT;
  const { instanceName, samplingTime, columns = [], modes = [] } = matrixDef;
  const MATRIX_NAME = 'IEMT_MTX';

  // ID seeds matching the Python tool's approach but using the existing mkBlock/mkVar counters.
  const outerCmId = preAllocatedId || mkBlock();
  counters.blocks++;

  const lines = [];

  // ── Outer CM block ─────────────────────────────────────────────────────────
  lines.push(`\t\t\t\t\t<PlantHierarchyFolder Name="${esc(instanceName)}" Type="ControlModule" ID="${outerCmId}">`);
  lines.push(`\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(outerCmId)}"/>`);
  lines.push(`\t\t\t\t\t\t<AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t<ProcessTagType>${MATRIX_NAME}</ProcessTagType>`);
  lines.push(`\t\t\t\t\t\t\t<SamplingTime>${esc(samplingTime || '100')}</SamplingTime>`);
  lines.push(`\t\t\t\t\t\t</AttributeList>`);
  lines.push(`\t\t\t\t\t\t<LinkList>`);
  lines.push(`\t\t\t\t\t\t\t<ControllerTargetAssignment TargetID="#${fx.CPU}"/>`);
  lines.push(`\t\t\t\t\t\t</LinkList>`);
  lines.push(`\t\t\t\t\t\t<ObjectList>`);

  // ── Inner CM block ─────────────────────────────────────────────────────────
  const innerCmId = mkBlock();
  counters.blocks++;
  lines.push(`\t\t\t\t\t\t\t<PlantHierarchyFolder Name="${MATRIX_NAME}" Type="ControlModule" ID="${innerCmId}">`);
  lines.push(`\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(innerCmId)}"/>`);
  lines.push(`\t\t\t\t\t\t\t\t<AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t\t\t<Comment>${MATRIX_NAME}</Comment>`);
  lines.push(`\t\t\t\t\t\t\t\t\t<ProcessTagType>${MATRIX_NAME}\\${MATRIX_NAME}</ProcessTagType>`);
  lines.push(`\t\t\t\t\t\t\t\t</AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t\t<ObjectList>`);

  // ── Mode ControlVariables ──────────────────────────────────────────────────
  const rcmSlots = columns.map((_, i) => `RCM${String(i + 1).padStart(2, '0')}`);

  for (const mode of modes) {
    const modeVarId = mkVar();
    counters.vars++;
    lines.push(`\t\t\t\t\t\t\t\t\t<ControlVariable Name="Mode${String(mode.mode_nr).padStart(2, '0')}" Type="VarInput" ID="${modeVarId}">`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(modeVarId)}"/>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t<DataType>Structure</DataType>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t<VariableType>Parameter</VariableType>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t<ObjectList>`);

    // iModeNr child
    const iModeNrId = mkVar();
    counters.vars++;
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t<ControlVariable Name="iModeNr" Type="VarInput" ID="${iModeNrId}">`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(iModeNrId)}"/>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t\t<DataType>Integer</DataType>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t\t<Value>${mode.mode_nr}</Value>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t\t<VariableType>Parameter</VariableType>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
    lines.push(`\t\t\t\t\t\t\t\t\t\t\t</ControlVariable>`);

    // One RCM slot per column
    const cells = mode.cells || {};
    columns.forEach((colName, ci) => {
      const rcm = rcmSlots[ci];
      const val = cells[colName] !== undefined ? cells[colName] : 0;
      const rcmId = mkVar();
      counters.vars++;
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t<ControlVariable Name="${rcm}" Type="VarInput" ID="${rcmId}">`);
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(rcmId)}"/>`);
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t\t<DataType>DoubleInt</DataType>`);
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t\t<Value>${val}</Value>`);
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t\t<VariableType>Parameter</VariableType>`);
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
      lines.push(`\t\t\t\t\t\t\t\t\t\t\t</ControlVariable>`);
    });

    lines.push(`\t\t\t\t\t\t\t\t\t\t</ObjectList>`);
    lines.push(`\t\t\t\t\t\t\t\t\t</ControlVariable>`);
  }

  // ── Trailing Mtx / MtxIn ──────────────────────────────────────────────────
  const mtxId = mkVar();
  counters.vars++;
  lines.push(`\t\t\t\t\t\t\t\t\t<ControlVariable Name="Mtx" Type="VarOutput" ID="${mtxId}">`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(mtxId)}"/>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t\t<DataType>Structure</DataType>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t\t<VariableType>Parameter</VariableType>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t\t\t</ControlVariable>`);

  const mtxInId = mkVar();
  counters.vars++;
  lines.push(`\t\t\t\t\t\t\t\t\t<ControlVariable Name="MtxIn" Type="VarInput" ID="${mtxInId}">`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(mtxInId)}"/>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t\t<DataType>Structure</DataType>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t\t<VariableType>Parameter</VariableType>`);
  lines.push(`\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t\t\t</ControlVariable>`);

  lines.push(`\t\t\t\t\t\t\t\t</ObjectList>`);
  lines.push(`\t\t\t\t\t\t\t</PlantHierarchyFolder>`);
  lines.push(`\t\t\t\t\t\t</ObjectList>`);
  lines.push(`\t\t\t\t\t</PlantHierarchyFolder>`);

  return lines;
}

// ── Per-instance emit (returns raw lines, baseline indent = 5 tabs) ──────────
// counters is mutated: { blocks, vars, msgs, links }
// preAllocatedId: optional — if provided, use it as the top-level folder ID
//                 (allows the caller to reference it before emitting)
// instanceIdMap:  optional — map of instanceName -> pre-allocated top-level ID
//                 used by EMs to cross-reference their assigned CMs
// wireSpec:       optional — { varName -> { type, srcInstance?, srcVar?, value? } }
//                 computed from composite connections for this instance
// exposedVarIds:  optional — map of pre-allocated { instanceName -> { varName -> varId } }
//                 so destinations can look up source IDs
// exposedVarIdOut: optional mutable map — filled with { varName -> varId } for vars
//                 in varIdRequests[instanceName], so downstream instances can reference them
// signalMap:      optional — { "<block>.<var>" -> { tag } } signal bindings for this
//                 instance. When a var is bound, it is emitted as a signal variable
//                 (<SignalName> + VariableType=Signal, no <Value>, no LinkList).
function emitInstanceLines(inst, counters, preAllocatedId, instanceIdMap, fx, wireSpec, exposedVarIds, exposedVarIdOut, signalMap) {
  fx = fx || FX_DEFAULT;
  const lines = [];
  const { cmTypeDef, instanceName, enabledBlocks, samplingTime, libType, roleAssignments } = inst;
  if (!cmTypeDef) return lines;

  const activeBlocks = cmTypeDef.subBlocks.filter(blk =>
    !blk.optional || enabledBlocks.includes(blk.name)
  );

  // preAllocatedVarIds: { varName -> varId } — use pre-allocated IDs when available
  // (prevents double-allocation for vars that are composite interconnection sources)
  const preAllocated = exposedVarIds?.[instanceName] || {};

  const blockIds = {}, varIds = {}, msgIds = {};
  for (const blk of activeBlocks) {
    const bid = mkBlock();
    blockIds[blk.name] = { id: bid, aid: appId(bid) };
    for (const v of blk.vars) {
      varIds[v.libId] = preAllocated[v.name] || mkVar();
    }
    for (const m of blk.msgs) msgIds[`${blk.name}:${m.name}`] = mkMsg();
  }
  // Build varName -> varId map for wire spec lookups and for export
  const varNameToId = {};
  for (const blk of activeBlocks) {
    for (const v of blk.vars) varNameToId[v.name] = varIds[v.libId];
  }
  if (exposedVarIdOut) {
    Object.assign(exposedVarIdOut, varNameToId);
  }
  const cmId = preAllocatedId || mkBlock();
  counters.blocks++;

  // Map library type to the correct PCS7 PlantHierarchyFolder Type attribute.
  const folderType = libType === 'EquipmentModule' ? 'EquipmentModule'
                   : libType === 'EquipmentPhase'  ? 'EquipmentPhase'
                   : 'ControlModule';

  lines.push(`\t\t\t\t\t<PlantHierarchyFolder Name="${esc(instanceName)}" Type="${folderType}" ID="${cmId}">`);
  lines.push(`\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(cmId)}"/>`);
  lines.push(`\t\t\t\t\t\t<AttributeList>`);
  lines.push(`\t\t\t\t\t\t\t<Comment>${esc(cmTypeDef.comment || '')}</Comment>`);
  lines.push(`\t\t\t\t\t\t\t<ProcessTagType>${esc(cmTypeDef.name)}</ProcessTagType>`);
  lines.push(`\t\t\t\t\t\t\t<SamplingTime>${esc(samplingTime || cmTypeDef.samplingTime || '1000')}</SamplingTime>`);
  lines.push(`\t\t\t\t\t\t</AttributeList>`);
  lines.push(`\t\t\t\t\t\t<LinkList>`);
  lines.push(`\t\t\t\t\t\t\t<ControllerTargetAssignment TargetID="#${fx.CPU}"/>`);
  lines.push(`\t\t\t\t\t\t</LinkList>`);

  // Role assignments for EM/EPH: emit ALL defined roles; LinkList only when assigned.
  // roleKindMap: { roleName -> 'cm'|'em' } — 'em' roles use EquipmentModuleAssignment (EPH).
  const roleKindMap = cmTypeDef.roleKindMap || {};
  const roleEntries = (cmTypeDef.roles || []).map(role => {
    const roleKind = roleKindMap[role] || 'cm';
    const assignedName = roleAssignments?.[role];
    const targetId = assignedName ? (instanceIdMap?.[assignedName] || null) : null;
    return { role, roleKind, targetId };
  });

  if (activeBlocks.length || roleEntries.length) {
    lines.push(`\t\t\t\t\t\t<ObjectList>`);
    for (const blk of activeBlocks) {
      // Block-omission rule: drop a block when it carries a REQUIRED dummy signal
      // that went unmatched (no hardware bound) and has no real signal — i.e.
      // "no block if required+unmatched". A real (hardware-matched) signal keeps
      // the block; a non-required unmatched dummy leaves the block in place with
      // the pin simply unbound. Dummies default to required when the flag is absent
      // (back-compat with rules created before reconciliation existed).
      const blockHasRealSignal = (blk.vars || []).some(v2 => {
        const s = signalMap?.[`${blk.name}.${v2.name}`];
        return s && !s.dummy;
      });
      const blockHasRequiredUnmatched = (blk.vars || []).some(v2 => {
        const s = signalMap?.[`${blk.name}.${v2.name}`];
        return s && s.dummy && (s.required ?? 1);
      });
      if (blockHasRequiredUnmatched && !blockHasRealSignal) {
        // Required signal(s) for this block are unmatched → omit the block.
        continue;
      }

      const { id: bid, aid: baid } = blockIds[blk.name];
      counters.blocks++;
      lines.push(`\t\t\t\t\t\t\t<PlantHierarchyFolder Name="${esc(blk.name)}" Type="ControlModule" ID="${bid}">`);
      lines.push(`\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${baid}"/>`);
      lines.push(`\t\t\t\t\t\t\t\t<AttributeList>`);
      lines.push(`\t\t\t\t\t\t\t\t\t<Comment>${esc(blk.comment || '')}</Comment>`);
      lines.push(`\t\t\t\t\t\t\t\t\t<ProcessTagType>${esc(cmTypeDef.name)}\\${esc(blk.name)}</ProcessTagType>`);
      lines.push(`\t\t\t\t\t\t\t\t</AttributeList>`);

      if (blk.vars.length || blk.msgs.length) {
        lines.push(`\t\t\t\t\t\t\t\t<ObjectList>`);
        for (const v of blk.vars) {
          const vid = varIds[v.libId];
          if (!vid) continue;
          counters.vars++;
          const resolvedLinks = v.libLinks.map(lid => varIds[lid]).filter(Boolean);
          if (resolvedLinks.length) counters.links += resolvedLinks.length;
          let effectiveVal = v.val;
          if (!effectiveVal && v.libLinks.length && !resolvedLinks.length) {
            const fb = FALLBACKS[`${blk.name}.${v.name}`];
            if (fb !== undefined && fb !== null) effectiveVal = fb;
          }

          // Apply composite wire spec for this variable
          const ws = wireSpec?.[v.name];
          let compositeLink = null;   // { targetId } for interconnection
          if (ws) {
            if (ws.type === 'value' && ws.value !== undefined && ws.value !== '') {
              // Override the library default value with the static assignment
              effectiveVal = ws.value;
            } else if (ws.type === 'interconnection') {
              // Look up the pre-allocated source variable ID
              const srcVarId = exposedVarIds?.[ws.srcInstance]?.[ws.srcVar];
              if (srcVarId) {
                compositeLink = srcVarId;
                counters.links++;
              }
            }
          }

          // Signal binding: only REAL (non-dummy) signals emit to XML.
          // Dummy signals never emit — they are internal coverage markers only.
          const rawSig = signalMap?.[`${blk.name}.${v.name}`];
          const sig = (rawSig && !rawSig.dummy) ? rawSig : null;

          lines.push(`\t\t\t\t\t\t\t\t\t<ControlVariable Name="${esc(v.name)}" Type="${esc(v.dir)}" ID="${vid}">`);
          lines.push(`\t\t\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(vid)}"/>`);
          lines.push(`\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
          if (v.comment)     lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Comment>${esc(v.comment)}</Comment>`);
          if (v.dtype)       lines.push(`\t\t\t\t\t\t\t\t\t\t\t<DataType>${esc(v.dtype)}</DataType>`);
          if (v.enumeration) lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Enumeration>${esc(v.enumeration)}</Enumeration>`);
          if (v.negation)    lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Negation>true</Negation>`);
          if (sig) {
            lines.push(`\t\t\t\t\t\t\t\t\t\t\t<SignalName>${esc(sig.tag)}</SignalName>`);
            lines.push(`\t\t\t\t\t\t\t\t\t\t\t<VariableType>Signal</VariableType>`);
          } else {
            if (effectiveVal)  lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Value>${esc(effectiveVal)}</Value>`);
            if (v.vtype)       lines.push(`\t\t\t\t\t\t\t\t\t\t\t<VariableType>${esc(v.vtype)}</VariableType>`);
          }
          lines.push(`\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
          // Library-internal interconnections (within the same CM type).
          // Suppressed when the variable is signal-bound.
          if (sig) {
            // no LinkList for signal variables
          } else if (resolvedLinks.length) {
            lines.push(`\t\t\t\t\t\t\t\t\t\t<LinkList>`);
            for (const tId of resolvedLinks)
              lines.push(`\t\t\t\t\t\t\t\t\t\t\t<InterconnectionSource TargetID="#${tId}"/>`);
            lines.push(`\t\t\t\t\t\t\t\t\t\t</LinkList>`);
          } else if (compositeLink) {
            // Cross-member interconnection from composite wiring
            lines.push(`\t\t\t\t\t\t\t\t\t\t<LinkList>`);
            lines.push(`\t\t\t\t\t\t\t\t\t\t\t<InterconnectionSource TargetID="#${compositeLink}"/>`);
            lines.push(`\t\t\t\t\t\t\t\t\t\t</LinkList>`);
          }
          lines.push(`\t\t\t\t\t\t\t\t\t</ControlVariable>`);
        }
        for (const m of blk.msgs) {
          const mid = msgIds[`${blk.name}:${m.name}`];
          if (!mid) continue;
          counters.msgs++;
          const key = `${cmTypeDef.name}:${blk.name}:${m.name}`;
          const ov  = MSG_OVERRIDES[key];
          const cls   = ov ? ov.cls   : m.cls;
          const event = ov ? ov.event : m.event;
          const prio  = ov ? ov.prio  : m.prio;
          const ack   = ov !== undefined ? ov.ack : !!m.ack;
          lines.push(`\t\t\t\t\t\t\t\t\t<Message Name="${esc(m.name)}" ID="${mid}">`);
          lines.push(`\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
          if (m.batch) lines.push(`\t\t\t\t\t\t\t\t\t\t\t<BatchID>${esc(m.batch)}</BatchID>`);
          lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Class>${esc(cls)}</Class>`);
          lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Event>${esc(event)}</Event>`);
          if (m.origin) lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Origin>${esc(m.origin)}</Origin>`);
          if (m.osarea) lines.push(`\t\t\t\t\t\t\t\t\t\t\t<OSArea>${esc(m.osarea)}</OSArea>`);
          lines.push(`\t\t\t\t\t\t\t\t\t\t\t<Priority>${esc(prio)}</Priority>`);
          if (ack) lines.push(`\t\t\t\t\t\t\t\t\t\t\t<WithAcknowledgement>true</WithAcknowledgement>`);
          lines.push(`\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
          lines.push(`\t\t\t\t\t\t\t\t\t</Message>`);
        }
        lines.push(`\t\t\t\t\t\t\t\t</ObjectList>`);
      }
      lines.push(`\t\t\t\t\t\t\t</PlantHierarchyFolder>`);
    }
    for (const ra of roleEntries) {
      const raId = mkBlock();
      const elem   = ra.roleKind === 'em' ? 'EquipmentModuleAssignment' : 'ControlModuleAssignment';
      const linkEl = ra.roleKind === 'em' ? 'AssignedEquipmentModule'   : 'AssignedControlModule';
      lines.push(`\t\t\t\t\t\t\t<${elem} ID="${raId}">`);
      lines.push(`\t\t\t\t\t\t\t\t<AppId AppName="SIMATIC" Value="${appId(raId)}"/>`);
      lines.push(`\t\t\t\t\t\t\t\t<AttributeList><Role>${esc(ra.role)}</Role></AttributeList>`);
      if (ra.targetId) {
        lines.push(`\t\t\t\t\t\t\t\t<LinkList>`);
        lines.push(`\t\t\t\t\t\t\t\t\t<${linkEl} TargetID="#${ra.targetId}"/>`);
        lines.push(`\t\t\t\t\t\t\t\t</LinkList>`);
      }
      lines.push(`\t\t\t\t\t\t\t</${elem}>`);
    }
    lines.push(`\t\t\t\t\t\t</ObjectList>`);
  }
  lines.push(`\t\t\t\t\t</PlantHierarchyFolder>`);
  return lines;
}

// Recursively emit a hierarchy folder + its descendants + instances assigned to it.
// `depth` is the tab depth of the folder's own opening line. Existing per-instance
// baseline is 5 tabs, so for a folder at depth D the instances live at D+2 (inside
// its ObjectList), and we prepend (D+2 - 5) extra tabs to each instance line.
function emitFolder(b, folder, depth, childrenOf, instsByFolder, counters, useLegacyId, instanceIdMap, legacyPcId, fx, wireSpecs, exposedVarIds, signalMaps) {
  fx = fx || FX_DEFAULT;
  const prefix = '\t'.repeat(depth);
  const folderId = useLegacyId ? (legacyPcId || FX_DEFAULT.PC) : mkBlock();
  counters.blocks++;

  b.raw(`${prefix}<PlantHierarchyFolder Name="${esc(folder.name)}" ID="${folderId}" Version="V6.0">`);
  b.raw(`${prefix}\t<AppId AppName="SIMATIC" Value="${folderId}"/>`);
  if (folder.s88_type) {
    b.raw(`${prefix}\t<AttributeList>`);
    b.raw(`${prefix}\t\t<Author/>`);
    b.raw(`${prefix}\t\t<Comment/>`);
    b.raw(`${prefix}\t\t<S88Type>${esc(folder.s88_type)}</S88Type>`);
    b.raw(`${prefix}\t</AttributeList>`);
  } else {
    b.raw(`${prefix}\t<AttributeList><Author/><Comment/></AttributeList>`);
  }

  const kids  = childrenOf[folder.id] || [];
  const insts = instsByFolder[folder.id] || [];
  if (kids.length || insts.length) {
    b.raw(`${prefix}\t<ObjectList>`);
    for (const kid of kids) emitFolder(b, kid, depth + 2, childrenOf, instsByFolder, counters, false, instanceIdMap, legacyPcId, fx, wireSpecs, exposedVarIds, signalMaps);
    if (insts.length) {
      const targetDepth = depth + 2;
      const baseDepth   = 5;
      const extra       = '\t'.repeat(Math.max(0, targetDepth - baseDepth));
      for (const inst of insts) {
        const instLines = inst.isMatrix
          ? emitMatrixInstanceLines(inst.matrixDef, counters, instanceIdMap?.[inst.instanceName], fx)
          : emitInstanceLines(inst, counters, instanceIdMap?.[inst.instanceName], instanceIdMap, fx,
              wireSpecs?.[inst.instanceName], exposedVarIds, (exposedVarIds ? (exposedVarIds[inst.instanceName] ||= {}) : undefined),
              signalMaps?.[inst.instanceName]);
        for (const l of instLines) b.raw(extra + l);
      }
    }
    b.raw(`${prefix}\t</ObjectList>`);
  }
  b.raw(`${prefix}</PlantHierarchyFolder>`);
}

// ── Build wire specs from composite connection groups ─────────────────────────
// connGroups: [{ connections: [{conn_type,from_member_idx,from_var_name,to_member_idx,to_var_name,static_value}],
//               memberInstanceNames: { [memberIdx]: instanceName } }]
// Returns two maps:
//   varIdRequests: { instanceName: Set<varName> }  — vars whose IDs must be pre-allocated & exposed
//   wireSpecs:     { instanceName: { varName: { type:'interconnection'|'value', srcInstance?, srcVar?, value? } } }
function buildWireSpecs(connGroups) {
  const varIdRequests = {};  // instanceName -> Set of var names that need a predictable ID
  const wireSpecs     = {};  // instanceName -> { varName -> wire entry }

  for (const grp of (connGroups || [])) {
    const { connections, memberInstanceNames } = grp;
    for (const c of connections) {
      const toInst = memberInstanceNames[c.to_member_idx];
      if (!toInst || !c.to_var_name) continue;

      if (!wireSpecs[toInst]) wireSpecs[toInst] = {};

      if (c.conn_type === 'value') {
        wireSpecs[toInst][c.to_var_name] = { type: 'value', value: c.static_value ?? '' };
      } else {
        // interconnection — source var ID must be known before dest is emitted
        const fromInst = memberInstanceNames[c.from_member_idx];
        if (!fromInst || !c.from_var_name) continue;
        if (!varIdRequests[fromInst]) varIdRequests[fromInst] = new Set();
        varIdRequests[fromInst].add(c.from_var_name);
        wireSpecs[toInst][c.to_var_name] = { type: 'interconnection', srcInstance: fromInst, srcVar: c.from_var_name };
      }
    }
  }
  return { varIdRequests, wireSpecs };
}

// ── Main generate function ────────────────────────────────────────────────────
// instances:         [{ cmTypeDef, instanceName, enabledBlocks, samplingTime }]
// hierarchy:         [{ id, parent_id, name, s88_type, sort_order }]  (optional)
// instanceFolderMap: { [instanceName]: folderId }                      (optional)
// projectConfig:     row from project_config table (optional — falls back to FX_DEFAULT)
// connGroups:        composite connection groups (optional — see buildWireSpecs)
// signalMaps:        signal-to-instance mappings (optional — additive). Shape:
//                    { [instanceName]: { "<block>.<var>": { tag, varDtype, signalType } } }
//                    When empty, output is byte-identical to the pre-feature export.
// Returns: { xml: string, stats: { blocks, vars, msgs, links } }
function generateXML(instances, projectName, hierarchy, instanceFolderMap, projectConfig, connGroups, signalMaps = {}) {
  resetCtr();
  const FX  = buildFX(projectConfig);
  const b   = makeBuilder();
  const now = new Date().toISOString().slice(0, 19);
  const NS  = 'http://www.siemens.com/automation/2005/SimaticML';

  // Use device_name / project_name from config when available, otherwise fall back to projectName arg.
  const xmlProjectName = projectConfig?.project_name || projectName;
  const xmlDeviceName  = projectConfig?.device_name  || projectName;
  const xmlExportUser  = projectConfig?.export_user  || 'GENERATED';

  // Stats counters (shared, mutated by helpers)
  const counters = { blocks: 0, vars: 0, msgs: 0, links: 0 };

  // ── Document header ─────────────────────────────────────────────────────────
  b.raw(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);
  b.raw(`<Document xmlns="${NS}">`);
  b.raw(`\t<DocumentInfo FormatVersion="2.3" Tool="AI" UserName="${esc(xmlExportUser)}" Created="${now}"/>`);
  b.raw(`\t<Project Name="${esc(xmlProjectName)}" ID="${FX.PROJ}" Version="V3.0" ExportScope="Comos PT;V4.2;2461d880">`);
  b.raw(`\t\t<AttributeList>`);
  b.raw(`\t\t\t<Attribute Name="Author"><Value></Value></Attribute>`);
  b.raw(`\t\t\t<Attribute Name="Comment"><Value></Value></Attribute>`);
  b.raw(`\t\t</AttributeList>`);
  b.raw(`\t\t<ObjectList>`);

  // ── Device section ──────────────────────────────────────────────────────────
  b.raw(`\t\t\t<Device Name="${esc(xmlDeviceName)}" Type="Central" ID="${FX.DEV}" Version="3.0">`);
  b.raw(`\t\t\t\t<AppId AppName="SIMATIC" Value="${FX.DEV}"/>`);
  b.raw(`\t\t\t\t<AttributeList><Attribute Name="S7StationType"><Value>S7400</Value></Attribute></AttributeList>`);
  b.raw(`\t\t\t\t<ObjectList>`);
  b.raw(`\t\t\t\t\t<DeviceItem Name="UR2ALU" Type="Rack" ID="${FX.RACK}" Version="3.0">`);
  b.raw(`\t\t\t\t\t\t<AttributeList>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="BuildIn"><Value>false</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="OrderNumber"><Value>6ES7 400-1JA11-0AA0</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="SubDevice"><Value>0</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="SubSystem"><Value>0</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t</AttributeList>`);
  b.raw(`\t\t\t\t\t</DeviceItem>`);
  b.raw(`\t\t\t\t\t<DeviceItem Name="CPU 410-5H" Type="ControllerTarget" ID="${FX.CPU}" Version="3.0">`);
  b.raw(`\t\t\t\t\t\t<AttributeList>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="BuildIn"><Value>false</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="FirmwareVersion"><Value>V8.2</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="OrderNumber"><Value>6ES7 410-5HX08-0AB0</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="Slot"><Value>3</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="SubDevice"><Value>0</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t\t<Attribute Name="SubSystem"><Value>0</Value></Attribute>`);
  b.raw(`\t\t\t\t\t\t</AttributeList>`);

  // ── IOTag Folder with reconciled signal tags ────────────────────────────────
  // Collect all REAL (hardware-matched) signals from signalMaps and emit IOTag
  // elements with resolved I/O addresses.
  // Collect all REAL (hardware-matched) signals from signalMaps, deduplicating by tag
  // name (multiple block-pins may bind the same physical signal).
  const ioTagsSeen = new Set();
  const ioTags = [];
  for (const pins of Object.values(signalMaps || {})) {
    for (const entry of Object.values(pins || {})) {
      if (entry.dummy || !entry.tag || !entry.ioAddress) continue;
      if (ioTagsSeen.has(entry.tag)) continue;
      ioTagsSeen.add(entry.tag);
      ioTags.push({
        name:     entry.tag,
        address:  entry.ioAddress,
        comment:  entry.comment || null,
        dataType: entry.varDtype || 'Bool',
      });
    }
  }

  // Extract parent IOTagFolder's type and ID for child IOTag IDs
  const parentTypeHex = '00113001';
  const parentIdHex = FX.IOTAG.split(':')[1] || '00006407';

  b.raw(`\t\t\t\t\t\t<ObjectList>`);
  b.raw(`\t\t\t\t\t\t\t<IOTagFolder ID="${FX.IOTAG}" Version="V6.0">`);
  b.raw(`\t\t\t\t\t\t\t\t<ObjectList>`);
  for (const tag of ioTags) {
    const tagId = mkIOTag(parentTypeHex, parentIdHex);
    b.raw(`\t\t\t\t\t\t\t\t\t<IOTag Name="${esc(tag.name)}" ID="${tagId}" Version="V6.0">`);
    b.raw(`\t\t\t\t\t\t\t\t\t\t<AttributeList>`);
    b.raw(`\t\t\t\t\t\t\t\t\t\t\t<Address>${esc(tag.address)}</Address>`);
    b.raw(tag.comment
      ? `\t\t\t\t\t\t\t\t\t\t\t<Comment>${esc(tag.comment)}</Comment>`
      : `\t\t\t\t\t\t\t\t\t\t\t<Comment/>`);
    b.raw(`\t\t\t\t\t\t\t\t\t\t\t<DataType>${esc(tag.dataType)}</DataType>`);
    b.raw(`\t\t\t\t\t\t\t\t\t\t</AttributeList>`);
    b.raw(`\t\t\t\t\t\t\t\t\t</IOTag>`);
  }
  b.raw(`\t\t\t\t\t\t\t\t</ObjectList>`);
  b.raw(`\t\t\t\t\t\t\t</IOTagFolder>`);
  b.raw(`\t\t\t\t\t\t</ObjectList>`);
  b.raw(`\t\t\t\t\t</DeviceItem>`);
  b.raw(`\t\t\t\t</ObjectList>`);
  b.raw(`\t\t\t</Device>`);

  counters.blocks++; // Device

  // Pre-allocate a top-level ID for every instance so EM role assignments can
  // reference CM instance IDs before those instances have been emitted.
  const instanceIdMap = {};
  for (const inst of instances) {
    instanceIdMap[inst.instanceName] = mkBlock();
  }

  // ── Composite connection wiring ──────────────────────────────────────────────
  // Build wire specs and pre-allocate source variable IDs so destination instances
  // can reference them even if the source instance is emitted after the destination.
  const { varIdRequests, wireSpecs } = buildWireSpecs(connGroups);

  // exposedVarIds: { instanceName -> { varName -> varId } }
  // Pre-populate IDs for all vars that will be referenced as interconnection sources.
  const exposedVarIds = {};
  for (const [instName, varNames] of Object.entries(varIdRequests)) {
    const instDef = instances.find(i => i.instanceName === instName);
    if (!instDef?.cmTypeDef) continue;
    exposedVarIds[instName] = {};
    for (const blk of instDef.cmTypeDef.subBlocks) {
      for (const v of blk.vars) {
        if (varNames.has(v.name)) {
          // Allocate the ID now; emitInstanceLines will reuse it via exposedVarIdOut
          exposedVarIds[instName][v.name] = mkVar();
        }
      }
    }
  }

  if (hierarchy && hierarchy.length) {
    // Build adjacency map and group instances by folder.
    const childrenOf = {};
    const folderById = {};
    for (const f of hierarchy) {
      folderById[f.id] = f;
      const pk = f.parent_id ?? null;
      (childrenOf[pk] ||= []).push(f);
    }
    // Sort by sort_order, then id, at each level.
    const cmp = (a, c) => (a.sort_order ?? 0) - (c.sort_order ?? 0) || a.id - c.id;
    for (const k of Object.keys(childrenOf)) childrenOf[k].sort(cmp);

    const roots = childrenOf[null] || [];
    const fallbackFolderId = roots[0]?.id ?? null;

    const instsByFolder = {};
    for (const inst of instances) {
      const target = (instanceFolderMap && instanceFolderMap[inst.instanceName])
        ?? null;
      const resolved = (target != null && folderById[target]) ? target : fallbackFolderId;
      if (resolved != null) (instsByFolder[resolved] ||= []).push(inst);
    }

    for (const root of roots) {
      emitFolder(b, root, 3, childrenOf, instsByFolder, counters, false, instanceIdMap, FX.PC, FX, wireSpecs, exposedVarIds, signalMaps);
    }
  } else {
    // Legacy: single Process cell(1) containing all instances (byte-identical to pre-feature output).
    b.raw(`\t\t\t<PlantHierarchyFolder Name="Process cell(1)" ID="${FX.PC}" Version="V6.0">`);
    b.raw(`\t\t\t\t<AppId AppName="SIMATIC" Value="${FX.PC}"/>`);
    b.raw(`\t\t\t\t<AttributeList><Author/><Comment/></AttributeList>`);
    b.raw(`\t\t\t\t<ObjectList>`);
    counters.blocks++; // ProcessCell
    for (const inst of instances) {
      const instLines = inst.isMatrix
        ? emitMatrixInstanceLines(inst.matrixDef, counters, instanceIdMap[inst.instanceName], FX)
        : emitInstanceLines(inst, counters, instanceIdMap[inst.instanceName], instanceIdMap, FX,
            wireSpecs[inst.instanceName], exposedVarIds, (exposedVarIds[inst.instanceName] ||= {}),
            signalMaps[inst.instanceName]);
      for (const l of instLines) b.raw(l);
    }
    b.raw(`\t\t\t\t</ObjectList>`);
    b.raw(`\t\t\t</PlantHierarchyFolder>`);
  }

  b.raw(`\t\t</ObjectList>`);
  b.raw(`\t</Project>`);
  b.raw(`</Document>`);

  const xml = b.result();
  return {
    xml,
    stats: {
      blocks: counters.blocks,
      vars:   counters.vars,
      msgs:   counters.msgs,
      links:  counters.links,
      sizeKb: parseFloat((Buffer.byteLength(xml, 'utf8') / 1024).toFixed(1)),
    },
  };
}

module.exports = { generateXML, emitMatrixInstanceLines };
