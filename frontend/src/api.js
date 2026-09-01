// src/api.js — All REST calls in one place
// When migrating to SQL Server, only the backend changes — this file stays the same.

const BASE = `${import.meta.env.VITE_API_BASE_URL || ''}/api`;

async function request(method, path, body, isFile = false) {
  const opts = { method, headers: {} };
  if (body && !isFile) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isFile) {
    opts.body = body; // FormData
  }
  const res = await fetch(`${BASE}${path}`, opts);
  // 204 No Content (and any empty body) has nothing to parse — res.json() would
  // throw "Unexpected end of JSON input" on an otherwise successful request.
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { if (res.ok) throw new Error('Invalid JSON response from server'); }
  }
  if (!res.ok) {
    const e = new Error(data?.error || `HTTP ${res.status}`);
    if (data?.conflictRows) e.conflictRows = data.conflictRows;
    throw e;
  }
  return data;
}

// ── Library (project-scoped) ──────────────────────────────────────────────────
export async function getLibraryStatus(projectId) {
  return request('GET', `/projects/${projectId}/library/status`);
}

// Returns { token, preview: [{name, cm_type, comment, blockCount, varCount}] }
export async function previewLibraryUpload(projectId, file, onProgress) {
  const fd = new FormData();
  fd.append('library', file);
  // Use XMLHttpRequest so we can track upload progress on large files
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/projects/${projectId}/library/upload`);
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) reject(new Error(data.error || `HTTP ${xhr.status}`));
        else resolve(data);
      } catch { reject(new Error('Invalid response')); }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    if (onProgress) xhr.upload.onprogress = e => onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.send(fd);
  });
}

export async function computeLibraryDiff(projectId, token) {
  return request('POST', `/projects/${projectId}/library/compute-diff`, { token });
}

export async function importLibrary(projectId, token, selectedNames) {
  return request('POST', `/projects/${projectId}/library/import`, { token, selectedNames });
}

export async function deleteCmType(projectId, name) {
  return request('DELETE', `/projects/${projectId}/cm-types/${encodeURIComponent(name)}`);
}

// ── Library — Full Export / Import (CM types + Composites + Matrix modes) ─────
// Triggers a browser download of the full library as a JSON file.
export async function downloadLibraryExport(projectId) {
  const res = await fetch(`${BASE}/projects/${projectId}/library/export`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const fnMatch = cd.match(/filename="?([^"]+)"?/);
  const filename = fnMatch ? fnMatch[1] : `library-export-${Date.now()}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Returns { token, cmTypes: {summary, items}, composites: {summary, items}, meta }
export async function previewLibraryImport(projectId, file) {
  const fd = new FormData();
  fd.append('file', file);
  return request('POST', `/projects/${projectId}/library/import2/preview`, fd, true);
}

export async function commitLibraryImport(projectId, token, selectedCmNames, selectedCompositeNames) {
  return request('POST', `/projects/${projectId}/library/import2/commit`, { token, selectedCmNames, selectedCompositeNames });
}

// Drops empty/absent filters so callers can pass `undefined` freely.
function auditQuery(params) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  ).toString();
  return qs ? `?${qs}` : '';
}

// ── Library — Audit Log ──────────────────────────────────────────────────────
export async function getLibraryAuditLog(projectId, params = {}) {
  return request('GET', `/projects/${projectId}/library/audit-log${auditQuery(params)}`);
}

// ── Instances — Audit Log ────────────────────────────────────────────────────
// params: { limit, offset, instance, user, action, from, to }
export async function getInstanceAuditLog(projectId, params = {}) {
  return request('GET', `/projects/${projectId}/instances/audit-log${auditQuery(params)}`);
}

export async function getEntityAuditLog(projectId, entityType, entityId) {
  return request('GET', `/projects/${projectId}/library/audit-log/${encodeURIComponent(entityType)}/${entityId}`);
}

// ── CM Types (project-scoped) ─────────────────────────────────────────────────
export async function getCmTypes(projectId) {
  return request('GET', `/projects/${projectId}/cm-types`);
}

export async function getCmTypeBlocks(projectId, cmTypeName) {
  return request('GET', `/projects/${projectId}/cm-types/${encodeURIComponent(cmTypeName)}/blocks`);
}
export async function getCmTypeBlockPrefs(projectId, cmTypeName) {
  return request('GET', `/projects/${projectId}/cm-types/${encodeURIComponent(cmTypeName)}/block-prefs`);
}
export async function saveCmTypeBlockPrefs(projectId, cmTypeName, enabledBlocks) {
  return request('PUT', `/projects/${projectId}/cm-types/${encodeURIComponent(cmTypeName)}/block-prefs`, { enabledBlocks });
}
export async function patchVarDefault(projectId, cmTypeName, varId, val) {
  return request('PATCH', `/projects/${projectId}/cm-types/${encodeURIComponent(cmTypeName)}/vars/${varId}`, { val });
}
export async function patchVarValid(projectId, cmTypeName, varId, isValid) {
  return request('PATCH', `/projects/${projectId}/cm-types/${encodeURIComponent(cmTypeName)}/vars/${varId}`, { is_valid: isValid });
}
export async function toggleBlockConditional(projectId, blockId, isConditional) {
  return request('PATCH', `/projects/${projectId}/cm-types/block/${blockId}/conditional`, { isConditional });
}

// ── SIMIT Export ──────────────────────────────────────────────────────────────
// Downloads SIMIT.xlsm for the given project. Accepts the same instances payload as
// generateXML so it uses the UI's current enabledBlocks, not the saved DB state.
export async function exportSimit(projectId, instances) {
  const res = await fetch(`${BASE}/simit-export/${projectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `SIMIT_${new Date().toISOString().slice(0, 10)}.xlsm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Generate ──────────────────────────────────────────────────────────────────
export async function generateXML({ projectName, userProjects, instances, generatedBy }) {
  return request('POST', '/generate', { projectName, userProjects, instances, generatedBy });
}

// Streaming generation: POSTs the payload and reads Server-Sent-Events progress
// frames from the response body. Calls onProgress({ pct, phase, msg }) for each
// progress frame and resolves with { outputs, auditIds } on the final "done" frame.
// Uses a relative /api URL so it rides the Vite dev proxy (avoids CORS on :5174).
export async function generateXMLStream({ projectName, userProjects, instances, generatedBy }, onProgress) {
  const res = await fetch(`${BASE}/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectName, userProjects, instances, generatedBy }),
  });
  if (!res.ok || !res.body) {
    // Server rejected before streaming (e.g. 4xx/5xx with JSON error).
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;

  const handleFrame = (raw) => {
    // Each SSE frame is one or more `data: ...` lines.
    const dataLines = raw.split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim());
    if (!dataLines.length) return;
    let obj;
    try { obj = JSON.parse(dataLines.join('\n')); } catch (_) { return; }
    if (obj.error) throw new Error(obj.error);
    if (obj.done)  { result = { outputs: obj.outputs, auditIds: obj.auditIds }; return; }
    onProgress?.(obj);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line (\n\n).
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      handleFrame(frame);
    }
  }
  // Flush any trailing frame without a terminating blank line.
  if (buffer.trim()) handleFrame(buffer);

  if (!result) throw new Error('Generation stream ended without a result');
  return result;
}

// ── Audit history ─────────────────────────────────────────────────────────────
export async function getHistory(limit = 50) {
  return request('GET', `/generate/history?limit=${limit}`);
}

export async function getHistoryDetail(id) {
  return request('GET', `/generate/history/${id}`);
}

// ── Projects ──────────────────────────────────────────────────────────────────
export async function listProjects()                          { return request('GET',    '/projects'); }
export async function getProject(id)                          { return request('GET',    `/projects/${id}`); }
export async function saveProject(payload)                    { return request('POST',   '/projects', payload); }
export async function deleteProject(id)                       { return request('DELETE', `/projects/${id}`); }
export async function deleteProjectInstance(projectId, name)  { return request('DELETE', `/projects/${projectId}/instances/${encodeURIComponent(name)}`); }
// Bulk variant — deletes many instances in one request instead of one request
// per instance (multi-select delete on a large grid was firing hundreds/
// thousands of individual DELETEs). Returns { success, deletedCount }.
export async function deleteProjectInstances(projectId, names) { return request('POST',   `/projects/${projectId}/instances/bulk-delete`, { instanceNames: names }); }

// ── Unit Types (project-scoped) ───────────────────────────────────────────────
export async function getUnitTypes(projectId)             { return request('GET',    `/unit-types/project/${projectId}/types`); }
export async function getUnitType(projectId, id)          { return request('GET',    `/unit-types/project/${projectId}/types/${id}`); }
export async function createUnitType(projectId, data)     { return request('POST',   `/unit-types/project/${projectId}/types`, data); }
export async function updateUnitType(projectId, id, data) { return request('PUT',    `/unit-types/project/${projectId}/types/${id}`, data); }
export async function deleteUnitType(projectId, id)       { return request('DELETE', `/unit-types/project/${projectId}/types/${id}`); }

// ── Unit Type Connections ─────────────────────────────────────────────────────
export async function getUnitTypeConnections(projectId, unitTypeId) {
  return request('GET', `/unit-types/project/${projectId}/types/${unitTypeId}/connections`);
}

export async function saveUnitTypeConnections(projectId, unitTypeId, connections, validateCycles = true) {
  return request('POST', `/unit-types/project/${projectId}/types/${unitTypeId}/connections`, { connections, validateCycles });
}

export async function deleteUnitTypeConnection(projectId, unitTypeId, connId) {
  return request('DELETE', `/unit-types/project/${projectId}/types/${unitTypeId}/connections/${connId}`);
}

export async function getCmTypeVariablesForUnit(projectId, unitTypeId) {
  return request('GET', `/unit-types/project/${projectId}/types/${unitTypeId}/cm-type-variables`);
}

// ── Unit Instances (per project) ──────────────────────────────────────────────
export async function getUnitInstances(projectId) {
  return request('GET', `/unit-types/project/${projectId}/unit-instances`);
}
export async function addUnitInstance(projectId, data) {
  return request('POST', `/unit-types/project/${projectId}/unit-instances`, data);
}
export async function updateUnitInstance(projectId, id, data) {
  return request('PUT', `/unit-types/project/${projectId}/unit-instances/${id}`, data);
}
export async function deleteUnitInstance(projectId, id) {
  return request('DELETE', `/unit-types/project/${projectId}/unit-instances/${id}`);
}
export async function expandUnitInstances(projectId) {
  return request('POST', `/unit-types/project/${projectId}/unit-instances/expand`);
}

// ── IO Import ─────────────────────────────────────────────────────────────────

export async function uploadIOList(projectId, file, sheetName, columnMapId) {
  const fd = new FormData();
  fd.append('iolist', file);
  let path = `/io/project/${projectId}/upload`;
  const qs = [];
  if (sheetName)   qs.push(`sheet=${encodeURIComponent(sheetName)}`);
  if (columnMapId) qs.push(`column_map_id=${columnMapId}`);
  if (qs.length)   path += '?' + qs.join('&');
  return request('POST', path, fd, true);
}

export async function listIOImports(projectId)  { return request('GET', `/io/project/${projectId}/imports`); }
export async function getLatestIoImport()       { return request('GET', `/io/imports/latest`); }
export async function getIOImport(id)           { return request('GET', `/io/imports/${id}`); }
export async function deleteIOImport(id)        { return request('DELETE', `/io/imports/${id}`); }
export async function reimportIOList(importId, file) {
  const fd = new FormData();
  fd.append('iolist', file);
  return request('POST', `/io/imports/${importId}/reimport`, fd, true);
}

export async function getIOHeaders(importId) {
  return request('GET', `/io/imports/${importId}/headers`);
}
export async function getIOPreview(importId, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/io/imports/${importId}/preview${qs ? '?' + qs : ''}`);
}
export async function getIOTags(importId, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/io/imports/${importId}/tags${qs ? '?' + qs : ''}`);
}
export async function patchIOTag(importId, tagId, body) {
  return request('PATCH', `/io/imports/${importId}/tags/${tagId}`, body);
}
export async function approveAllIOTags(importId, tagIds) {
  return request('POST', `/io/imports/${importId}/approve-all`, tagIds ? { tag_ids: tagIds } : {});
}
export async function rejectIOTag(importId, tagId) {
  return request('POST', `/io/imports/${importId}/tags/${tagId}/reject`);
}

export async function getIOColumnPrefs(importId) {
  return request('GET', `/io/imports/${importId}/column-prefs`);
}
export async function saveIOColumnPrefs(importId, activeColumns) {
  return request('PUT', `/io/imports/${importId}/column-prefs`, { activeColumns });
}

export async function getIOColumnMaps(projectId)           { return request('GET',    `/io/project/${projectId}/column-maps`); }
export async function createIOColumnMap(projectId, data)      { return request('POST',   `/io/project/${projectId}/column-maps`, data); }
export async function updateIOColumnMap(projectId, id, data)  { return request('PUT',    `/io/project/${projectId}/column-maps/${id}`, data); }
export async function deleteIOColumnMap(projectId, id)        { return request('DELETE', `/io/project/${projectId}/column-maps/${id}`); }
export async function applyIOColumnMap(importId, column_map_id) {
  return request('POST', `/io/imports/${importId}/apply-column-map`, { column_map_id });
}
// Records the "real" column-map config for this import (the one with the hardware
// mapping), independent of column_map_id which "Import Instances" later overwrites.
export async function setIOSourceColumnMap(importId, column_map_id) {
  return request('POST', `/io/imports/${importId}/set-source-column-map`, { column_map_id });
}

export async function getIOFunctionMaps(projectId)              { return request('GET',    `/io/project/${projectId}/function-maps`); }
export async function createIOFunctionMap(projectId, data)         { return request('POST',   `/io/project/${projectId}/function-maps`, data); }
export async function updateIOFunctionMap(projectId, id, data)     { return request('PUT',    `/io/project/${projectId}/function-maps/${id}`, data); }
export async function deleteIOFunctionMap(projectId, id)           { return request('DELETE', `/io/project/${projectId}/function-maps/${id}`); }
export async function getIOFunctionMapMappings(projectId, id)      { return request('GET',    `/io/project/${projectId}/function-maps/${id}/mappings`); }
export async function saveIOFunctionMapMappings(projectId, id, mappings) {
  return request('PUT', `/io/project/${projectId}/function-maps/${id}/mappings`, { mappings });
}

export async function buildIOHierarchy(importId, levelMap) {
  return request('POST', `/io/imports/${importId}/build-hierarchy`, levelMap ? { levelMap } : {});
}
export async function getIOHierarchyLevels() { return request('GET', '/io/hierarchy-levels'); }
export async function getIOHierarchy(importId)      { return request('GET',  `/io/imports/${importId}/hierarchy`); }

export async function runIOAssignment(importId, function_map_id) {
  return request('POST', `/io/imports/${importId}/assign`, { function_map_id });
}
export async function getIOUnresolvedFunctions(importId) {
  return request('GET', `/io/imports/${importId}/unresolved-functions`);
}

export async function getIOValidationReport(importId) { return request('GET', `/io/imports/${importId}/validation-report`); }

export async function promoteIOImport(importId, projectId) {
  return request('POST', `/io/imports/${importId}/promote`, { projectId });
}

export function ioExportUrl(importId) { return `/api/io/imports/${importId}/export`; }

export async function detectIOConflicts(importId, projectId) {
  return request('POST', '/io-conflicts/detect', { importId, projectId });
}

export async function applyIOPromotion(importId, projectId) {
  return request('POST', '/io-conflicts/apply', { importId, projectId });
}

// ── Automated Workflow ───────────────────────────────────────────────────────────
// Streaming execution: POSTs the payload and reads Server-Sent-Events progress frames.
// Calls onProgress({ pct, phase, msg }) for each frame and resolves with { success, xml, stats, auditId }.
export async function executeWorkflowStream({ importId, projectId, functionMapId }, onProgress) {
  const res = await fetch(`${BASE}/workflow/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ importId, projectId, functionMapId }),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;

  const handleFrame = (raw) => {
    const dataLines = raw.split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim());
    if (!dataLines.length) return;
    let obj;
    try { obj = JSON.parse(dataLines.join('\n')); } catch (_) { return; }
    if (obj.error) {
      const e = new Error(obj.error);
      if (obj.conflictRows) e.conflictRows = obj.conflictRows;
      throw e;
    }
    if (obj.done) { result = obj; return; }
    if (onProgress && (obj.pct !== undefined || obj.phase)) onProgress(obj);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop(); // Incomplete frame
      for (const frame of frames) if (frame.trim()) handleFrame(frame);
    }
    buffer += decoder.decode(); // Flush
    if (buffer.trim()) handleFrame(buffer);
    return result || { success: false, error: 'No response from server' };
  } catch (err) {
    throw err;
  } finally {
    reader.releaseLock();
  }
}

// ── PCS7 Project Config ───────────────────────────────────────────────────────
export async function getProjectConfig(projectId) {
  return request('GET', `/projects/${projectId}/pcs7-config`);
}
export async function saveProjectConfig(projectId, data) {
  return request('PUT', `/projects/${projectId}/pcs7-config`, data);
}
export async function parseProjectXml(projectId, file) {
  const fd = new FormData();
  fd.append('pcs7xml', file);
  return request('POST', `/projects/${projectId}/pcs7-config/parse-xml`, fd, true);
}

// ── PCS7 User-Project Config (per-user-project scoping) ────────────────────
export async function getUserProjectConfig(projectId, userProjectName) {
  return request('GET', `/projects/${projectId}/user-projects/${encodeURIComponent(userProjectName)}/pcs7-config`);
}
export async function saveUserProjectConfig(projectId, userProjectName, data) {
  return request('PUT', `/projects/${projectId}/user-projects/${encodeURIComponent(userProjectName)}/pcs7-config`, data);
}
export async function parseUserProjectXml(projectId, userProjectName, file) {
  const fd = new FormData();
  fd.append('pcs7xml', file);
  return request('POST', `/projects/${projectId}/user-projects/${encodeURIComponent(userProjectName)}/pcs7-config/parse-xml`, fd, true);
}
export async function saveUserProjectConfigWithWarning(projectId, userProjectName, config, targetUserProject) {
  return request('POST', `/projects/${projectId}/user-projects/${encodeURIComponent(userProjectName)}/pcs7-config/save-with-warning`, { config, targetUserProject });
}
export async function addUserProjectDevice(projectId, userProjectName, device) {
  return request('POST', `/projects/${projectId}/user-projects/${encodeURIComponent(userProjectName)}/pcs7-config/devices`, device);
}
export async function updateUserProjectDevice(projectId, userProjectName, deviceId, device) {
  return request('PUT', `/projects/${projectId}/user-projects/${encodeURIComponent(userProjectName)}/pcs7-config/devices/${deviceId}`, device);
}
export async function deleteUserProjectDevice(projectId, userProjectName, deviceId) {
  return request('DELETE', `/projects/${projectId}/user-projects/${encodeURIComponent(userProjectName)}/pcs7-config/devices/${deviceId}`);
}

// ── Valve / Mode Commands ─────────────────────────────────────────────────────
export async function getValveCommands()              { return request('GET', '/valve-commands'); }
export async function saveValveCommands(entries)       { return request('PUT', '/valve-commands', entries); }

// ── HW Engineering Extension ─────────────────────────────────────────────────
export async function hexToIp(hex) {
  return request('GET', `/hw-config/utils/hex-to-ip?hex=${encodeURIComponent(hex)}`);
}
export async function listHwSignalTypes() {
  return request('GET', '/hw-config/signal-types');
}
export async function addHwSignalType(name) {
  return request('POST', '/hw-config/signal-types', { name });
}
export async function listHwModuleTemplates() {
  return request('GET', '/hw-config/module-templates');
}
export async function upsertHwModuleTemplate(data) {
  return request('POST', '/hw-config/module-templates', data);
}
export async function getHwModuleTemplateUsage(id) {
  return request('GET', `/hw-config/module-templates/${id}/usage`);
}
export async function deleteHwModuleTemplate(id) {
  return request('DELETE', `/hw-config/module-templates/${id}`);
}

// ── Tier 2 Hardware Resolution (Protocol + SignalType → Card MLFB) ────────────
export async function listHwHardwareResolutions(page = 0, limit = 200) {
  return request('GET', `/hw-config/hardware-resolution?page=${page}&limit=${limit}`);
}
export async function upsertHwHardwareResolution(data) {
  return request('POST', '/hw-config/hardware-resolution', data);
}
export async function deleteHwHardwareResolution(id) {
  return request('DELETE', `/hw-config/hardware-resolution/${id}`);
}
export function exportHwHardwareResolutionUrl() {
  return `${BASE}/hw-config/hardware-resolution/export`;
}
export async function importHwHardwareResolutionCsv(file) {
  const fd = new FormData();
  fd.append('csv', file);
  return request('POST', '/hw-config/hardware-resolution/import', fd, true);
}
export async function parseCfgForCatalogue(file) {
  const fd = new FormData();
  fd.append('cfg', file);
  return request('POST', '/hw-config/module-templates/parse-cfg', fd, true);
}
export async function bulkUpsertCatalogueTemplates(devices) {
  return request('POST', '/hw-config/module-templates/bulk-upsert', { devices });
}

// ── Module Parameters (extracted from CFG PARAMETER blocks) ────────────────────
export async function getModuleParameters(templateId) {
  return request('GET', `/module-parameters/templates/${templateId}`);
}
export async function getModuleParametersGrouped(templateId) {
  return request('GET', `/module-parameters/templates/${templateId}/grouped`);
}
export async function updateModuleChannelParameter(templateId, parameterName, channelType, parameterValue, spareValue = null, isDynamic = false) {
  return request('PATCH', `/module-parameters/templates/${templateId}/channel-param`, {
    parameter_name: parameterName,
    channel_type: channelType,
    parameter_value: parameterValue,
    spare_value: spareValue,
    is_dynamic: isDynamic
  });
}
export async function updateModuleLevelParameter(templateId, parameterName, parameterValue) {
  return request('PATCH', `/module-parameters/templates/${templateId}/module-param`, {
    parameter_name: parameterName,
    parameter_value: parameterValue
  });
}
export async function updateModuleParameterVisibility(templateId, updates) {
  return request('PATCH', `/module-parameters/templates/${templateId}/visibility`, {
    updates
  });
}
export async function listHwImports(projectId) {
  return request('GET', `/hw-config/project/${projectId}/imports`);
}
export async function uploadHwBaseline(projectId, file) {
  const fd = new FormData();
  fd.append('baseline', file);
  return request('POST', `/hw-config/project/${projectId}/upload-baseline`, fd, true);
}
export async function uploadHwIoList(importId, file, sheetName, columnMapJson) {
  const fd = new FormData();
  fd.append('iolist', file);
  const params = new URLSearchParams();
  if (sheetName) params.append('sheet', sheetName);
  if (columnMapJson) params.append('columnMap', columnMapJson);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request('POST', `/hw-config/imports/${importId}/upload-iolist${qs}`, fd, true);
}
export async function previewHwIoList(importId, file, sheetName, columnMapJson) {
  const fd = new FormData();
  fd.append('iolist', file);
  const params = new URLSearchParams();
  if (sheetName) params.append('sheet', sheetName);
  if (columnMapJson) params.append('columnMap', columnMapJson);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request('POST', `/hw-config/imports/${importId}/preview-iolist${qs}`, fd, true);
}

export async function applyHwIoList(importId, approvedKeys, parsedRows, fileName, missingKeys) {
  return request('POST', `/hw-config/imports/${importId}/apply-iolist`,
    { approvedKeys, parsedRows, fileName, missingKeys });
}

// Unified import: copy an IO import's raw rows into a HW import's hw_excel_raw,
// so the Hardware preview/mapping can consume the same sheet (no re-upload).
export async function ingestIoRowsIntoHw(hwImportId, ioImportId) {
  return request('POST', `/hw-config/imports/${hwImportId}/ingest-io-rows`, { ioImportId });
}

// Multi-controller variant: split the IO rows across the project's HW imports by
// the AS-assignment column. Returns { groups, skipped, ambiguous, totalRows }.
export async function ingestIoRowsSplitByAs(projectId, ioImportId, asColumn, orderNoColumn) {
  return request('POST', `/hw-config/project/${projectId}/ingest-io-rows-split`,
    { ioImportId, asColumn, orderNoColumn });
}

// Preview HW import using stored rows + a column mapping (no file upload).
export async function previewHwMapped(hwImportId, columnMap) {
  const qs = `?columnMap=${encodeURIComponent(JSON.stringify(columnMap))}`;
  return request('GET', `/hw-config/imports/${hwImportId}/preview-mapped${qs}`);
}

export async function getColumnMappingSuggestions(importId, selectedColumns) {
  return request('POST', `/hw-config/imports/${importId}/suggest-column-mappings`,
    { selectedColumns });
}

export async function loadHwColumnMapping(importId) {
  return request('GET', `/hw-config/imports/${importId}/column-mapping`);
}

export async function saveHwColumnMapping(importId, mapping) {
  return request('POST', `/hw-config/imports/${importId}/column-mapping`, { mapping });
}

export async function getHwStations(importId) {
  return request('GET', `/hw-config/imports/${importId}/stations`);
}
export async function backfillFromCfg(importId, file) {
  const fd = new FormData();
  fd.append('cfg', file);
  return request('POST', `/hw-config/imports/${importId}/backfill-from-cfg`, fd, true);
}
export async function getHwAddressPreview(importId) {
  return request('GET', `/hw-config/imports/${importId}/preview-addresses`);
}
export async function getHwSignals(importId, page = 0, limit = 100) {
  return request('GET', `/hw-config/imports/${importId}/signals?page=${page}&limit=${limit}`);
}
export async function updateHwStation(importId, addr, data) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}`, data);
}
export async function updateHwSlot(importId, addr, slot, data) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}`, data);
}
export async function addHwStation(importId, data) {
  return request('POST', `/hw-config/imports/${importId}/stations`, data);
}
export async function copyHwStation(importId, addr) {
  return request('POST', `/hw-config/imports/${importId}/stations/${addr}/copy`);
}
export async function deleteHwStation(importId, addr) {
  return request('DELETE', `/hw-config/imports/${importId}/stations/${addr}`);
}
export async function addHwSlot(importId, addr, data) {
  return request('POST', `/hw-config/imports/${importId}/stations/${addr}/slots`, data);
}
export async function deleteHwSlot(importId, addr, slot) {
  return request('DELETE', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}`);
}
export async function getSlotChannels(importId, addr, slot) {
  return request('GET', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/channels`);
}
export async function getAllSlotChannels(importId) {
  return request('GET', `/hw-config/imports/${importId}/all-slot-channels`);
}
export async function patchSlotChannel(importId, addr, slot, ch, data) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/channels/${ch}`, data);
}
export async function patchSlotPip(importId, addr, slot, pipNo) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/pip`, { pipNo });
}
export async function patchSlotPotentialGroup(importId, addr, slot, potentialGroup) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/potential-group`, { potentialGroup });
}
export async function patchSlotPaProfile(importId, addr, slot, paProfile) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/pa-profile`, { paProfile });
}
export async function patchSlotSubslotProfile(importId, addr, slot, ssNo, paProfile) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/subslots/${ssNo}/pa-profile`, { paProfile });
}
export async function generateHwCfg(importId, options = {}) {
  return request('POST', `/hw-config/imports/${importId}/generate`, options);
}
export async function bulkDeleteHwStations(importId, addresses) {
  return request('POST', `/hw-config/imports/${importId}/stations/bulk-delete`, { addresses });
}
export async function bulkApproveHwStations(importId, addresses, approved = true) {
  return request('POST', `/hw-config/imports/${importId}/stations/bulk-approve`, { addresses, approved });
}
export async function listHwCfgs(importId) {
  return request('GET', `/hw-config/imports/${importId}/cfgs`);
}
export function hwCfgDownloadUrl(importId, cfgId) {
  return `/api/hw-config/imports/${importId}/cfgs/${cfgId}/download`;
}
export async function exportHwConfig(importId) {
  const response = await fetch(`/api/hw-config/imports/${importId}/export`, { method: 'GET' });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.blob();
}
export async function importHwConfig(importId, file) {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`/api/hw-config/imports/${importId}/import`, {
    method: 'POST',
    body: formData,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
  return data;
}

// ── HW Controllers (migrated from App2) ──────────────────────────────────────
export async function listHwControllers(projectId) {
  return request('GET', `/hw-controllers?projectId=${projectId}`);
}
export async function createHwController(data) {
  return request('POST', '/hw-controllers', data);
}
export async function updateHwController(id, data) {
  return request('PUT', `/hw-controllers/${id}`, data);
}
export async function deleteHwController(id) {
  return request('DELETE', `/hw-controllers/${id}`);
}
export async function copyHwController(id) {
  return request('POST', `/hw-controllers/${id}/copy`);
}

// ── HW Fieldbuses (migrated from App2) ───────────────────────────────────────
export async function listHwFieldbuses(controllerId) {
  return request('GET', `/hw-fieldbuses?controllerId=${controllerId}`);
}
export async function createHwFieldbus(data) {
  return request('POST', '/hw-fieldbuses', data);
}
export async function updateHwFieldbus(id, data) {
  return request('PUT', `/hw-fieldbuses/${id}`, data);
}
export async function deleteHwFieldbus(id) {
  return request('DELETE', `/hw-fieldbuses/${id}`);
}

// ── Slot ↔ Subslot Compatibility ─────────────────────────────────────────────
export async function listSlotCompat() {
  return request('GET', '/hw-config/slot-compat');
}
export async function addSlotCompat(slot_order_no, subslot_order_no, is_default = false) {
  return request('POST', '/hw-config/slot-compat', { slot_order_no, subslot_order_no, is_default });
}
export async function removeSlotCompat(slot_order_no, subslot_order_no) {
  return request('DELETE', '/hw-config/slot-compat', { slot_order_no, subslot_order_no });
}

// ── MRP Configuration ─────────────────────────────────────────────────────────
export async function mrpGetDevices(importId) {
  return request('GET', `/mrp/${importId}/devices`);
}
export async function mrpGetConfig(importId) {
  return request('GET', `/mrp/${importId}/config`);
}
export async function mrpSaveConfig(importId, config) {
  return request('POST', `/mrp/${importId}/config`, config);
}
export async function mrpImportFromCfg(importId, file) {
  const fd = new FormData();
  fd.append('cfg', file);
  return request('POST', `/mrp/${importId}/import-from-cfg`, fd, true);
}
export async function mrpDownloadCfg(importId) {
  const res = await fetch(`${BASE}/mrp/${importId}/apply`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd   = res.headers.get('Content-Disposition') || '';
  const fnMatch = cd.match(/filename="?([^"]+)"?/);
  const filename = fnMatch ? fnMatch[1] : 'station_mrp.cfg';
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Composite CM Types (project-scoped) ───────────────────────────────────────
export async function listCompositeCmTypes(projectId)           { return request('GET',    `/projects/${projectId}/composite-cm-types`); }
export async function getCompositeCmType(projectId, id)         { return request('GET',    `/projects/${projectId}/composite-cm-types/${id}`); }
export async function createCompositeCmType(projectId, data)    { return request('POST',   `/projects/${projectId}/composite-cm-types`, data); }
export async function updateCompositeCmType(projectId, id, data){ return request('PUT',    `/projects/${projectId}/composite-cm-types/${id}`, data); }
export async function deleteCompositeCmType(projectId, id)      { return request('DELETE', `/projects/${projectId}/composite-cm-types/${id}`); }

// ── IO Connection Rules (lib_io_connections, project-scoped) ─────────────────
export async function getIoConnections(projectId, cmTypeId) {
  return request('GET', `/io-connections/project/${projectId}/cm-type/${cmTypeId}`);
}
export async function createIoConnection(projectId, cmTypeId, data) {
  return request('POST', `/io-connections/project/${projectId}/cm-type/${cmTypeId}`, data);
}
export async function updateIoConnection(id, data) {
  return request('PUT', `/io-connections/${id}`, data);
}
export async function deleteIoConnection(id) {
  return request('DELETE', `/io-connections/${id}`);
}
export async function reorderIoConnections(projectId, cmTypeId, ids) {
  return request('PATCH', `/io-connections/project/${projectId}/cm-type/${cmTypeId}/reorder`, { ids });
}

// ── Signal-to-Instance Mapping ────────────────────────────────────────────────
export async function getSignalMappings(projectId, instance) {
  const qs = instance ? `?instance=${encodeURIComponent(instance)}` : '';
  return request('GET', `/signal-mappings/project/${projectId}${qs}`);
}
export async function saveInstanceSignalMappings(projectId, instanceName, mappings) {
  return request('PUT', `/signal-mappings/project/${projectId}/instance/${encodeURIComponent(instanceName)}`, { mappings });
}
export async function deleteSignalMapping(id) {
  return request('DELETE', `/signal-mappings/${id}`);
}
export async function getMappableSignals(projectId, { q = '', type = '', limit = 200 } = {}) {
  const params = new URLSearchParams();
  if (q)    params.set('q', q);
  if (type) params.set('type', type);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return request('GET', `/signal-mappings/project/${projectId}/signals${qs ? '?' + qs : ''}`);
}

// ── Connection Generation (dummy ↔ hardware reconciliation) ───────────────────
// Match every CM instance dummy IO against hardware symbols by exact name. Match
// → REAL (bound to hardware address); no match → stays DUMMY. Re-runnable.
export async function generateConnections(projectId) {
  return request('POST', `/connections/project/${projectId}/generate`);
}
export async function getExportedBlocks(projectId, instanceName) {
  return request('GET', `/connections/${projectId}/${encodeURIComponent(instanceName)}/exported-blocks`);
}
export async function getConnectionIOs(projectId, status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return request('GET', `/connections/project/${projectId}${qs}`);
}
export async function getDerivedValues(projectId) {
  return request('GET', `/connections/derived-values/${projectId}`);
}
// Set (value != null) or clear (value === null) a manual override for one derived
// Value pin. Overrides take priority over the auto-resolved IO-list value in the
// modal, in getDerivedValues, and in XML export.
export async function setDerivedValueOverride(projectId, instanceName, varName, value) {
  return request('PUT', `/connections/derived-values/${projectId}/instance/${encodeURIComponent(instanceName)}/override`, { varName, value });
}

// Per-instance matrix override — one `enabled` flag + edited cells for a matrix CM
// instance. When enabled, cells win over the composite type's matrix defaults in the
// Parameters modal and in XML export. `cells` is keyed by mode_nr → { colName: value }.
export async function getMatrixOverrides(projectId) {
  return request('GET', `/connections/matrix-override/${projectId}`);
}
export async function setMatrixOverride(projectId, instanceName, enabled, cells) {
  return request('PUT', `/connections/matrix-override/${projectId}/instance/${encodeURIComponent(instanceName)}`, { enabled, cells });
}

// ── EPH/EM Import System ──────────────────────────────────────────────────────
export async function uploadEphEmList(projectId, file, sheetName, columnMapId) {
  const fd = new FormData();
  fd.append('ephemlist', file);
  let path = `/eph-em/project/${projectId}/upload`;
  const qs = [];
  if (sheetName)   qs.push(`sheet=${encodeURIComponent(sheetName)}`);
  if (columnMapId) qs.push(`column_map_id=${columnMapId}`);
  if (qs.length)   path += '?' + qs.join('&');
  return request('POST', path, fd, true);
}

export async function listEphEmImports(projectId) { return request('GET', `/eph-em/project/${projectId}/imports`); }
export async function getEphEmImport(id) { return request('GET', `/eph-em/imports/${id}`); }
export async function deleteEphEmImport(id) { return request('DELETE', `/eph-em/imports/${id}`); }

export async function getEphEmRows(importId, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/eph-em/imports/${importId}/rows${qs ? '?' + qs : ''}`);
}

export async function patchEphEmRow(importId, rowId, body) {
  return request('PATCH', `/eph-em/imports/${importId}/rows/${rowId}`, body);
}

export async function rejectEphEmRow(importId, rowId) {
  return request('DELETE', `/eph-em/imports/${importId}/rows/${rowId}`);
}

export async function getEphEmColumnMaps(projectId) { return request('GET', `/eph-em/project/${projectId}/column-maps`); }
export async function createEphEmColumnMap(projectId, data) { return request('POST', `/eph-em/project/${projectId}/column-maps`, data); }
export async function updateEphEmColumnMap(projectId, id, data) { return request('PUT', `/eph-em/project/${projectId}/column-maps/${id}`, data); }
export async function deleteEphEmColumnMap(projectId, id) { return request('DELETE', `/eph-em/project/${projectId}/column-maps/${id}`); }

export async function applyEphEmColumnMap(importId, mappings, headers) {
  return request('POST', `/eph-em/imports/${importId}/apply-column-map`, { mappings, headers });
}

export async function getEphEmFunctionMapConfigs(projectId) { return request('GET', `/eph-em/project/${projectId}/function-map-configs`); }
export async function createEphEmFunctionMapConfig(projectId, data) { return request('POST', `/eph-em/project/${projectId}/function-map-configs`, data); }

export async function getEphEmTypeMappingConfigs(projectId) { return request('GET', `/eph-em/project/${projectId}/type-mapping-configs`); }
export async function createEphEmTypeMappingConfig(projectId, data) { return request('POST', `/eph-em/project/${projectId}/type-mapping-configs`, data); }
export async function updateEphEmTypeMappingConfig(projectId, id, data) { return request('PATCH', `/eph-em/project/${projectId}/type-mapping-configs/${id}`, data); }
export async function deleteEphEmTypeMappingConfig(projectId, id) { return request('DELETE', `/eph-em/project/${projectId}/type-mapping-configs/${id}`); }

export async function runEphEmAssignment(importId, type_column_mappings) {
  return request('POST', `/eph-em/imports/${importId}/assign`, { type_column_mappings });
}

export async function promoteEphEmImport(importId, projectId) {
  return request('POST', `/eph-em/imports/${importId}/promote`, { projectId });
}

export async function detectInstanceConflicts(projectId, instances) {
  return request('POST', '/instance-conflicts/detect', { projectId, instances });
}

export async function resolveInstanceConflicts(projectId, instances, resolutions) {
  return request('POST', '/instance-conflicts/resolve', { projectId, instances, resolutions });
}

export async function detectUnitInstanceConflicts(projectId) {
  return request('POST', '/instance-conflicts/unit-instances/detect', { projectId });
}

export async function expandUnitInstancesWithResolution(projectId, plannedInstances, resolutions) {
  return request('POST', '/instance-conflicts/unit-instances/expand', { projectId, plannedInstances, resolutions });
}

// ── Reconciliation ────────────────────────────────────────────────────────────
export async function runReconciliation(projectId) {
  return request('POST', `/reconciliation/project/${projectId}/run`);
}

export async function getReconciliationSummary(projectId) {
  return request('GET', `/reconciliation/project/${projectId}/summary`);
}

export async function getReconciliationInstances(projectId, { status, search } = {}) {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (search) qs.set('search', search);
  const suffix = qs.toString() ? `?${qs}` : '';
  return request('GET', `/reconciliation/project/${projectId}/instances${suffix}`);
}

export async function acceptDummyInstance(instanceId, acceptedBy) {
  return request('PATCH', `/reconciliation/instances/${instanceId}/accept`, { acceptedBy });
}

export async function revertDummyInstance(instanceId) {
  return request('PATCH', `/reconciliation/instances/${instanceId}/revert`);
}

export async function bulkAcceptDummyInstances(instanceIds, acceptedBy) {
  return request('PATCH', '/reconciliation/instances/bulk-accept', { instanceIds, acceptedBy });
}

export async function bulkRevertDummyInstances(instanceIds) {
  return request('PATCH', '/reconciliation/instances/bulk-revert', { instanceIds });
}
