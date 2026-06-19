// src/api.js — All REST calls in one place
// When migrating to SQL Server, only the backend changes — this file stays the same.

const BASE = '/api';

async function request(method, path, body, isFile = false) {
  const opts = { method, headers: {} };
  if (body && !isFile) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isFile) {
    opts.body = body; // FormData
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Library ───────────────────────────────────────────────────────────────────
export async function getLibraryStatus() {
  return request('GET', '/library/status');
}

// Returns { token, preview: [{name, cm_type, comment, blockCount, varCount}] }
export async function previewLibraryUpload(file, onProgress) {
  const fd = new FormData();
  fd.append('library', file);
  // Use XMLHttpRequest so we can track upload progress on large files
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/library/upload`);
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

export async function importLibrary(token, selectedNames) {
  return request('POST', '/library/import', { token, selectedNames });
}

export async function deleteCmType(name) {
  return request('DELETE', `/cm-types/${encodeURIComponent(name)}`);
}

// ── CM Types ──────────────────────────────────────────────────────────────────
export async function getCmTypes() {
  return request('GET', '/cm-types');
}

export async function getCmTypeBlocks(cmTypeName) {
  return request('GET', `/cm-types/${encodeURIComponent(cmTypeName)}/blocks`);
}
export async function patchVarDefault(cmTypeName, varId, val) {
  return request('PATCH', `/cm-types/${encodeURIComponent(cmTypeName)}/vars/${varId}`, { val });
}
export async function patchVarValid(cmTypeName, varId, isValid) {
  return request('PATCH', `/cm-types/${encodeURIComponent(cmTypeName)}/vars/${varId}`, { is_valid: isValid });
}

// ── Generate ──────────────────────────────────────────────────────────────────
export async function generateXML({ projectName, userProjects, instances, generatedBy }) {
  return request('POST', '/generate', { projectName, userProjects, instances, generatedBy });
}

// ── Audit history ─────────────────────────────────────────────────────────────
export async function getHistory(limit = 50) {
  return request('GET', `/generate/history?limit=${limit}`);
}

export async function getHistoryDetail(id) {
  return request('GET', `/generate/history/${id}`);
}

// ── Projects ──────────────────────────────────────────────────────────────────
export async function listProjects()       { return request('GET',    '/projects'); }
export async function getProject(id)       { return request('GET',    `/projects/${id}`); }
export async function saveProject(payload) { return request('POST',   '/projects', payload); }
export async function deleteProject(id)    { return request('DELETE', `/projects/${id}`); }

// ── Unit Types (global library) ───────────────────────────────────────────────
export async function getUnitTypes()             { return request('GET',    '/unit-types'); }
export async function getUnitType(id)            { return request('GET',    `/unit-types/${id}`); }
export async function createUnitType(data)        { return request('POST',   '/unit-types', data); }
export async function updateUnitType(id, data)    { return request('PUT',    `/unit-types/${id}`, data); }
export async function deleteUnitType(id)          { return request('DELETE', `/unit-types/${id}`); }

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

export async function getIOColumnMaps()           { return request('GET',    '/io/column-maps'); }
export async function createIOColumnMap(data)      { return request('POST',   '/io/column-maps', data); }
export async function updateIOColumnMap(id, data)  { return request('PUT',    `/io/column-maps/${id}`, data); }
export async function deleteIOColumnMap(id)        { return request('DELETE', `/io/column-maps/${id}`); }
export async function applyIOColumnMap(importId, column_map_id) {
  return request('POST', `/io/imports/${importId}/apply-column-map`, { column_map_id });
}

export async function getIOFunctionMaps()              { return request('GET',    '/io/function-maps'); }
export async function createIOFunctionMap(data)         { return request('POST',   '/io/function-maps', data); }
export async function updateIOFunctionMap(id, data)     { return request('PUT',    `/io/function-maps/${id}`, data); }
export async function deleteIOFunctionMap(id)           { return request('DELETE', `/io/function-maps/${id}`); }
export async function getIOFunctionMapMappings(id)      { return request('GET',    `/io/function-maps/${id}/mappings`); }
export async function saveIOFunctionMapMappings(id, mappings) {
  return request('PUT', `/io/function-maps/${id}/mappings`, { mappings });
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

// ── Valve / Mode Commands ─────────────────────────────────────────────────────
export async function getValveCommands()              { return request('GET', '/valve-commands'); }
export async function saveValveCommands(entries)       { return request('PUT', '/valve-commands', entries); }

// ── HW Engineering Extension ─────────────────────────────────────────────────
export async function hexToIp(hex) {
  return request('GET', `/hw-config/utils/hex-to-ip?hex=${encodeURIComponent(hex)}`);
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
export async function parseCfgForCatalogue(file) {
  const fd = new FormData();
  fd.append('cfg', file);
  return request('POST', '/hw-config/module-templates/parse-cfg', fd, true);
}
export async function bulkUpsertCatalogueTemplates(devices) {
  return request('POST', '/hw-config/module-templates/bulk-upsert', { devices });
}
export async function listHwImports(projectId) {
  return request('GET', `/hw-config/project/${projectId}/imports`);
}
export async function uploadHwBaseline(projectId, file) {
  const fd = new FormData();
  fd.append('baseline', file);
  return request('POST', `/hw-config/project/${projectId}/upload-baseline`, fd, true);
}
export async function uploadHwIoList(importId, file, sheetName) {
  const fd = new FormData();
  fd.append('iolist', file);
  const qs = sheetName ? `?sheet=${encodeURIComponent(sheetName)}` : '';
  return request('POST', `/hw-config/imports/${importId}/upload-iolist${qs}`, fd, true);
}
export async function getHwStations(importId) {
  return request('GET', `/hw-config/imports/${importId}/stations`);
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
export async function patchSlotChannel(importId, addr, slot, ch, data) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/channels/${ch}`, data);
}
export async function patchSlotPip(importId, addr, slot, pipNo) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/pip`, { pipNo });
}
export async function patchSlotPotentialGroup(importId, addr, slot, potentialGroup) {
  return request('PATCH', `/hw-config/imports/${importId}/stations/${addr}/slots/${slot}/potential-group`, { potentialGroup });
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

// ── Composite CM Types ────────────────────────────────────────────────────────
export async function listCompositeCmTypes()           { return request('GET',    '/composite-cm-types'); }
export async function getCompositeCmType(id)           { return request('GET',    `/composite-cm-types/${id}`); }
export async function createCompositeCmType(data)       { return request('POST',   '/composite-cm-types', data); }
export async function updateCompositeCmType(id, data)   { return request('PUT',    `/composite-cm-types/${id}`, data); }
export async function deleteCompositeCmType(id)         { return request('DELETE', `/composite-cm-types/${id}`); }
