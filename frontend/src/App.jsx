import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);
import {
  getLibraryStatus, previewLibraryUpload, computeLibraryDiff, importLibrary,
  getCmTypes, getCmTypeBlocks, getCmTypeBlockPrefs, saveCmTypeBlockPrefs, patchVarDefault, patchVarValid,
  generateXML, generateXMLStream, getHistory,
  listProjects, getProject, saveProject, deleteProject,
  deleteCmType,
  getUnitTypes, getUnitType, createUnitType, updateUnitType, deleteUnitType,
  getUnitTypeConnections, saveUnitTypeConnections, deleteUnitTypeConnection, getCmTypeVariablesForUnit,
  getUnitInstances, addUnitInstance, updateUnitInstance, deleteUnitInstance, expandUnitInstances,
  listCompositeCmTypes, getCompositeCmType, createCompositeCmType, updateCompositeCmType, deleteCompositeCmType,
  getProjectConfig, saveProjectConfig, parseProjectXml,
  getValveCommands, saveValveCommands,
  getIoConnections, createIoConnection, updateIoConnection, deleteIoConnection,
  generateConnections, getConnectionIOs,
  listHwImports, ingestIoRowsIntoHw,
  getLatestIoImport, getIOHeaders,
} from "./api.js";
import StepIOImport from "./StepIOImport.jsx";
import StepHWConfig from "./StepHWConfig.jsx";
import InstancesGrid from "./InstancesGrid.tsx";
import SignalMappingModal from "./SignalMappingModal.jsx";
import UnitConnectionsEditor from "./UnitConnectionsEditor.jsx";
import LibraryImportReview from "./LibraryImportReview.jsx";
import UnitTypeImportModal from "./UnitTypeImportModal.jsx";
import UnitTypeSpirograph from "./UnitTypeSpirograph.jsx";
import Spinner from "./Spinner.jsx";
import ProgressBar from "./ProgressBar.jsx";
import Sidebar from "./Sidebar.jsx";
import { GlobalLoadingProvider } from "./LoadingContext.jsx";

const STEPS = ["Projects", "IO Import", "Library", "Unit Types", "Hierarchy", "Instances", "HW Config", "Generate"];
const DEFAULT_ON_OPTIONAL = ["MV_Rate"];
const S88_TYPES = ["", "ProcessCell", "Unit", "EMOD"];

// Monotonic client-side id generator for new hierarchy folders.
let _folderClientCtr = 1;
const newFolderClientId = () => `cf${_folderClientCtr++}`;

export default function App() {
  const [step, setStep]               = useState(0);
  const [libStatus, setLibStatus]     = useState(null);   // { cm_count, last_loaded }
  const [cmTypes, setCmTypes]         = useState([]);      // from DB
  const [cmtProfiles, setProfiles]    = useState([]);      // { id, cmType, enabledBlocks }
  const [instances, setInstances]     = useState([]);
  const [savedProjectName, setSavedProjectName] = useState("");  // the container name
  const [userProjects, setUserProjects]         = useState([]);  // ["AS01","AS02"]
  const [hierarchy, setHierarchy]               = useState([]);  // [{id, parentId, name, s88Type, sortOrder, dbId?}]
  const [result, setResult]           = useState(null);    // { outputs: [{userProject, xml, stats}], auditIds }
  const [loading, setLoading]         = useState("");
  const [uiLoading, setUiLoading]     = useState("");      // global UI feedback spinner
  const [genProgress, setGenProgress] = useState(null);    // { pct, phase, msg } while generating XML; null = idle
  const [error, setErrorRaw]          = useState("");
  const [errorConflictRows, setErrorConflictRows] = useState(null); // tabular detail for duplicate-station errors
  // setError(str) clears conflictRows (existing call sites, unchanged behavior).
  // setError(Error) — e.g. setError(e) from a catch block — also captures e.conflictRows
  // (attached by api.js on "Duplicate stations" 400s) for tabular display in the banner.
  const setError = (errOrMsg) => {
    if (errOrMsg instanceof Error) {
      setErrorRaw(errOrMsg.message);
      setErrorConflictRows(errOrMsg.conflictRows || null);
    } else {
      setErrorRaw(errOrMsg);
      setErrorConflictRows(null);
    }
  };
  const [importPreview, setImportPreview] = useState(null); // { token, diffResult }
  const [importDiff, setImportDiff]   = useState(null);     // diff result from compute-diff

  // ── Unit Type state ─────────────────────────────────────────────────────
  const [unitTypes, setUnitTypes]           = useState([]);   // global library list
  const [unitInstances, setUnitInstances]   = useState([]);   // per-project
  const [savedProjectId, setSavedProjectId] = useState(null); // DB id of current project
  const [pendingHwMapping, setPendingHwMapping] = useState(null); // { ioImportId, hardwareMappings } handed off from unified IO screen
  const [compositeCmTypes, setCompositeCmTypes] = useState([]); // global composite library
  const [projectConfig, setProjectConfig]   = useState(null);  // PCS7 hardware IDs
  const [valveCommands, setValveCommands]   = useState([]);    // user-editable mode command lookup

  // ── Unit Connections state ─────────────────────────────────────────────────
  const [unitConnections, setUnitConnections]           = useState({});     // unitTypeId -> connections[]
  const [cmTypeVarCache, setCmTypeVarCache]             = useState({});     // member alias -> {vars, subMembers, ...}

  // Check library status on mount + load unit types + composite types
  useEffect(() => {
    getLibraryStatus()
      .then(s => {
        setLibStatus(s);
        if (s.cm_count > 0) loadCmTypes();
      })
      .catch(() => {});
    loadUnitTypes();
    loadCompositeCmTypesList();
    loadValveCommands();
  }, []);

  // Two-phase render for the Instances tab (step 5): the grid renders 2000 rows
  // synchronously, which blocks the main thread for several seconds and prevents
  // the browser from painting the spinner. So we hold the grid back for one paint:
  // goTo() sets uiLoading + step, this effect waits until the spinner has actually
  // been painted (double rAF), then clears uiLoading so the grid mounts next frame.
  useEffect(() => {
    if (step === 5 && uiLoading) {
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setUiLoading(""));
      });
      return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    }
  }, [step, uiLoading]);

  async function loadValveCommands() {
    try {
      const rows = await getValveCommands();
      setValveCommands(rows.map(r => ({ label: `${r.name} (${r.value})`, value: r.value, name: r.name })));
    } catch (_) {}
  }

  async function loadUnitTypes() {
    try { setUnitTypes(await getUnitTypes()); } catch (_) {}
  }

  async function loadCompositeCmTypesList() {
    try { setCompositeCmTypes(await listCompositeCmTypes()); } catch (_) {}
  }

  async function loadUnitInstances(projectId) {
    try {
      setUnitInstances(await getUnitInstances(projectId));
    } catch (_) {}
  }

  async function loadProjectConfig(projectId) {
    try { setProjectConfig(await getProjectConfig(projectId)); } catch (_) {}
  }

  // Load connections and variables when unit type is selected
  async function loadUnitTypeConnections(unitTypeId) {
    try {
      const [conns, vars] = await Promise.all([
        getUnitTypeConnections(unitTypeId),
        getCmTypeVariablesForUnit(unitTypeId)
      ]);
      setUnitConnections(prev => ({ ...prev, [unitTypeId]: conns }));
      setCmTypeVarCache(vars);
    } catch (err) {
      setError(`Failed to load connections: ${err.message}`);
    }
  }

  async function saveUnitConnectionsEditor(unitTypeId, connections) {
    setError("");
    try {
      await saveUnitTypeConnections(unitTypeId, connections, true);
      setUnitConnections(prev => ({ ...prev, [unitTypeId]: connections }));
    } catch (err) {
      const msg = `Failed to save connections: ${err.message}`;
      setError(msg);
      throw new Error(msg); // re-throw so caller knows save failed
    }
  }

  async function loadCmTypes() {
    const types = await getCmTypes();
    setCmTypes(types);
    setProfiles(types.map(cm => ({
      id:            cm.name,
      cmType:        cm.name,
      libType:       cm.cm_type,   // "ControlModule" | "EquipmentModule" | "EquipmentPhase"
      comment:       cm.comment,
      samplingTime:  cm.sampling_time,
      totalBlocks:   cm.total_blocks,
      optionalBlocks: cm.optional_blocks,
      // We don't know which are default-on until we load blocks for this CM type
      // enabledBlocks is populated lazily when user selects the CM in CMT Config
      enabledBlocks: null,
      roles:         null,   // loaded lazily via ensureBlocksLoaded
    })));
  }

  // Lazy-load block details for a CM type when needed
  async function ensureBlocksLoaded(cmTypeName) {
    const existing = cmtProfiles.find(p => p.id === cmTypeName);
    if (existing?.subBlocks && existing?.roles !== null) return existing; // already fully loaded
    const detail = await getCmTypeBlocks(cmTypeName);

    // Load saved user preferences for enabled blocks
    let enabledBlocks = existing?.enabledBlocks;
    if (!enabledBlocks) {
      try {
        const prefs = await getCmTypeBlockPrefs(cmTypeName);
        if (prefs?.enabledBlocks?.length > 0) {
          enabledBlocks = prefs.enabledBlocks;
        }
      } catch (_) {}
    }

    // Fall back to defaults if no saved preferences and not from a project
    if (!enabledBlocks) {
      enabledBlocks = detail.subBlocks
        .filter(b => !b.optional || DEFAULT_ON_OPTIONAL.includes(b.name))
        .map(b => b.name);
    }

    const roles = detail.roles || [];
    const roleKindMap = detail.roleKindMap || {};
    setProfiles(prev => prev.map(p =>
      p.id === cmTypeName ? { ...p, subBlocks: detail.subBlocks, enabledBlocks, roles, roleKindMap } : p
    ));
    return { ...existing, subBlocks: detail.subBlocks, enabledBlocks, roles, roleKindMap };
  }

  // ── Step 1: upload library ───────────────────────────────────────────────
  async function handleUpload(file) {
    setLoading("Uploading and parsing library…");
    setError("");
    setImportDiff(null);
    try {
      const r = await previewLibraryUpload(file, pct => setLoading(`Uploading… ${pct}%`));
      setLoading("Computing diff…");
      // Compute diff to show what will change
      const diff = await computeLibraryDiff(r.token);
      setLoading("");
      setImportPreview({ token: r.token });
      setImportDiff(diff);
    } catch (e) {
      setError(e.message);
      setLoading("");
    }
  }

  async function handleImportConfirm(selectedNames) {
    setLoading("Importing selected types…");
    setError("");
    try {
      const r = await importLibrary(importPreview.token, [...selectedNames]);
      setImportPreview(null);
      setImportDiff(null);
      setLoading(`Imported ${r.new} new, ${r.updated} updated, ${r.blocks} blocks, ${r.vars} vars`);
      await loadCmTypes();
      const status = await getLibraryStatus();
      setLibStatus(status);
      setTimeout(() => { setLoading(""); }, 1200);
    } catch (e) {
      setError(e.message);
      setLoading("");
    }
  }

  async function handleDeleteCmType(name) {
    if (!window.confirm(`Remove "${name}" from the library?`)) return;
    try {
      await deleteCmType(name);
      const types = await getCmTypes();
      setCmTypes(types);
      setProfiles(prev => prev.filter(p => p.id !== name));
      const status = await getLibraryStatus();
      setLibStatus(status);
    } catch (e) {
      setError(e.message);
    }
  }

  // ── Project load ─────────────────────────────────────────────────────────
  // The `loading` flag also suppresses auto-save while we're hydrating state
  // from the server — otherwise the partial loads would each trigger a save.
  const hydratingRef = useRef(false);

  async function loadProjectIntoState(id) {
    hydratingRef.current = true;
    try {
      const proj = await getProject(id);
      setSavedProjectId(proj.id);
      setSavedProjectName(proj.name);
      loadUnitInstances(proj.id);
      loadProjectConfig(proj.id);
      setUserProjects(proj.userProjects || []);
      const byCm = Object.fromEntries(proj.cmtProfiles.map(p => [p.cmType, p.enabledBlocks]));
      setProfiles(prev => prev.map(p =>
        byCm[p.id] ? { ...p, enabledBlocks: byCm[p.id] } : p
      ));

      // Hierarchy: each row has a DB id; we adopt those directly as client ids
      // (stringified) so existing relationships survive without remapping.
      const dbToClient = {};
      const hyd = (proj.hierarchy || []).map(f => {
        const cid = `db${f.id}`;
        dbToClient[f.id] = cid;
        return {
          id:        cid,
          parentId:  f.parent_id != null ? `db${f.parent_id}` : null,
          name:      f.name,
          s88Type:   f.s88_type || "",
          sortOrder: f.sort_order ?? 0,
        };
      });
      setHierarchy(hyd);

      setInstances(proj.instances.map((i, idx) => {
        const inst = {
          id:               Date.now() + idx,
          profileId:        i.cm_type,
          instanceName:     i.instance_name,
          samplingTime:     i.sampling_time || "1000",
          userProject:      i.user_project || "",
          folderId:         i.folder_id != null ? dbToClient[i.folder_id] || "" : "",
          roleAssignments:  i.role_assignments || {},
          compositeGroupId: i.composite_group_id ?? undefined,
          compositeId:      i.composite_id      ?? undefined,
          memberIdx:        i.member_idx        ?? undefined,
          source:           i.source || "manual",
          connections:      i.connections || [],
        };
        // Auto-hydrate: if this is a composite member but connections are empty,
        // it likely was created manually or is from an old save. Mark for lazy
        // hydration so connections are populated when the composite detail loads.
        if (inst.compositeId != null && inst.memberIdx != null && !inst.connections.length) {
          inst._needsConnections = true;
        }
        return inst;
      }));
      // Stay on the Projects step — the user reviews user projects and
      // clicks Continue when ready.
    } finally {
      // Release on the next tick so the state updates above don't trigger a save.
      setTimeout(() => { hydratingRef.current = false; }, 0);
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  // Persist the entire working set (user projects, hierarchy, instances incl.
  // their IO `connections`, block prefs). Returns a promise so callers that need
  // the DB to be current — e.g. "Generate Connections" — can await it first.
  async function saveProjectNow() {
    if (!savedProjectName.trim()) return;
    // Hierarchy: send in topological order (parents before children) so the
    // backend can resolve parentClientId → dbId in a single pass.
    const orderedHierarchy = topoSortHierarchy(hierarchy);

    const resp = await saveProject({
      name:         savedProjectName,
      comment:      "",
      userProjects,
      hierarchy:    orderedHierarchy.map((f, idx) => ({
        clientId:       f.id,
        parentClientId: f.parentId,
        name:           f.name,
        s88_type:       f.s88Type || null,
        sort_order:     idx,
      })),
      instances:    instances.map(i => ({
        cm_type:            i.profileId,
        instance_name:      i.instanceName,
        sampling_time:      i.samplingTime,
        user_project:       i.userProject || null,
        folder_client_id:   i.folderId || null,
        role_assignments:   i.roleAssignments || {},
        composite_group_id: i.compositeGroupId ?? null,
        composite_id:       i.compositeId      ?? null,
        member_idx:         i.memberIdx        ?? null,
        source:             i.source || "manual",
        connections:        i.connections || [],
      })),
      cmtProfiles:  cmtProfiles
        .filter(p => p.enabledBlocks)
        .map(p => ({ cmType: p.id, enabledBlocks: p.enabledBlocks })),
    });

    // Rewrite freshly-created (`cf…`) client folder ids to their assigned DB ids.
    // Existing `db…` ids are preserved by the backend (same row reused).
    const map = resp?.folderIdMap || {};
    const needsRemap = Object.keys(map).some(k => !k.startsWith("db"));
    if (needsRemap) {
      const remap = cid => {
        if (!cid) return cid;
        if (cid.startsWith("db")) return cid;
        return map[cid] != null ? `db${map[cid]}` : cid;
      };
      hydratingRef.current = true;
      setHierarchy(prev => prev.map(f => ({
        ...f,
        id:       remap(f.id),
        parentId: f.parentId ? remap(f.parentId) : null,
      })));
      setInstances(prev => prev.map(i => ({
        ...i,
        folderId: i.folderId ? remap(i.folderId) : "",
      })));
      setTimeout(() => { hydratingRef.current = false; }, 0);
    }
    return resp;
  }

  // ── Auto-save ───────────────────────────────────────────────────────────
  // Debounce every change to the working set; persists transparently.
  useEffect(() => {
    if (!savedProjectName.trim()) return;
    if (hydratingRef.current) return;
    const handle = setTimeout(() => {
      saveProjectNow().catch(e => setError(`Auto-save failed: ${e.message}`));
    }, 600);
    return () => clearTimeout(handle);
  }, [savedProjectName, userProjects, instances, cmtProfiles, hierarchy]);

  function toggleBlock(profileId, blockName) {
    setProfiles(prev => prev.map(p => {
      if (p.id !== profileId) return p;
      const has = p.enabledBlocks?.includes(blockName);
      const nextEnabled = has
        ? p.enabledBlocks.filter(b => b !== blockName)
        : [...(p.enabledBlocks || []), blockName];
      // Save to database
      saveCmTypeBlockPrefs(profileId, nextEnabled).catch(err => {
        console.error('Failed to save block preferences:', err);
      });
      return { ...p, enabledBlocks: nextEnabled };
    }));
  }

  // ── Helper: Extract IO and Value connections for a composite member ──────
  function extractMemberConnections(detail, memberIdx) {
    if (!detail?.connections || memberIdx == null) return [];
    return (detail.connections || [])
      .filter(c => Number(c.to_member_idx) === memberIdx)
      .map(c => {
        if (c.conn_type === "io_connection") {
          return {
            conn_type: "io_connection",
            target_block: c.block_name || "",
            target_pin:   c.to_var_name || "",
            prefix:       c.prefix || "",
            suffix:       c.suffix || "",
            signal_type:  c.dtype || c.signal_type || "DI",
            required:     c.required ? 1 : 0,
          };
        } else if (c.conn_type === "value") {
          return {
            conn_type: "value",
            target_pin: c.to_var_name || "",
            value_mode: c.value_mode || "static",
            static_value: c.static_value || "",
            column: c.column || "",
            prefix: c.prefix || "",
            suffix: c.suffix || "",
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  // ── Add instances from a composite CM type ──────────────────────────────
  // baseName: the tag / instrument name (used as-is for the primary member)
  // memberFolders: { memberIdx -> folderId } – each member's assigned folder (manual placement, no hierarchy rules)
  // When manually adding (not from import/generation), ignore composite type's hierarchy_folder rules
  async function addCompositeInstances({ compositeId, baseName, memberFolders = {}, userProject }) {
    const detail = await getCompositeCmType(compositeId);

    const members = detail.members || [];
    if (!members.length) return;

    let newHierarchy = [...hierarchy];

    // For manual addition: use the exact folder assignments provided (memberFolders[idx]),
    // ignoring the composite type's hierarchy_folder rules.
    const memberFolderIds = members.map((m, idx) => memberFolders[idx] || null);

    // Derive instance name for each member
    const groupId = Date.now(); // unique id for this composite group
    const existingNames = new Set(instances.map(i => i.instanceName));
    const newInstances = [];
    members.forEach((m, i) => {
      const name = m.is_primary
        ? baseName
        : `${m.name_prefix || ""}${baseName}${m.name_suffix || ""}`;
      if (existingNames.has(name)) return; // skip duplicate (e.g. shared project-scope instance)
      existingNames.add(name);
      const memberConnections = extractMemberConnections(detail, i);
      newInstances.push({
        id:              groupId + i,
        profileId:       m.cm_type_name || cmtProfiles[0]?.id || "",
        instanceName:    name,
        samplingTime:    "1000",
        userProject:     userProject || userProjects[0] || "",
        folderId:        memberFolderIds[i] || "",
        roleAssignments: {},
        source:          "manual",
        connections:     memberConnections,
        // Composite wiring metadata — used during XML generation
        compositeGroupId: groupId,
        compositeId:      compositeId,
        memberIdx:        i,
      });
    });
    setInstances(prev => [...prev, ...newInstances]);
  }

  function addInstance(preferredLibType) {
    const leaves = leafFolders(hierarchy);
    // Pick the first profile matching the preferred type, fallback to first overall
    const defaultProfile = preferredLibType
      ? (cmtProfiles.find(p => p.libType === preferredLibType) || cmtProfiles[0])
      : cmtProfiles[0];
    const prefix = preferredLibType === "EquipmentModule" ? "EM_"
                 : preferredLibType === "EquipmentPhase"  ? "EPH_"
                 : "CM_";
    setInstances(prev => {
      // Count existing instances of the same type for a clean index
      const sameType = prev.filter(i => {
        const p = cmtProfiles.find(x => x.id === i.profileId);
        return !preferredLibType || p?.libType === preferredLibType;
      });
      return [...prev, {
        id:              Date.now(),
        profileId:       defaultProfile?.id || "",
        instanceName:    `${prefix}${String(sameType.length + 1).padStart(3, "0")}`,
        samplingTime:    "1000",
        userProject:     userProjects[0] || "",
        folderId:        leaves[0]?.id || "",
        roleAssignments: {},
        source:          "manual",
      }];
    });
  }
  function removeInstance(id)     { setInstances(p => p.filter(i => i.id !== id)); }
  function updateInstance(id,k,v) { setInstances(p => p.map(i => i.id === id ? {...i,[k]:v} : i)); }
  function updateInstanceRole(id, role, assignedInstanceName) {
    setInstances(p => p.map(i => {
      if (i.id !== id) return i;
      const ra = { ...(i.roleAssignments || {}) };
      if (assignedInstanceName) ra[role] = assignedInstanceName;
      else delete ra[role];
      return { ...i, roleAssignments: ra };
    }));
  }

  async function handleGenerate() {
    if (genProgress) return;   // already generating — prevent double-submit
    setError("");
    try {
      if (!userProjects.length) throw new Error("Define at least one user project");
      if (instances.some(i => !i.userProject)) throw new Error("Every instance must be assigned to a user project");

      // Build the payload — enabledBlocks must be loaded for each used CM type
      const usedTypes = [...new Set(instances.map(i => i.profileId))];
      for (const t of usedTypes) await ensureBlocksLoaded(t);

      // Folder ids must be DB-resolved (`db…` prefix) before generate — the backend
      // looks them up in the persisted hierarchy. If any `cf…` is still pending,
      // the auto-save hasn't flushed yet; ask the user to wait a moment.
      const pendingFolder = hierarchy.some(f => !f.id?.startsWith("db"));
      if (pendingFolder) throw new Error("Saving hierarchy… try again in a moment.");
      const folderClientToDb = Object.fromEntries(
        hierarchy.map(f => [f.id, Number(f.id.slice(2))])
      );

      const payload = instances.map(inst => {
        const profile = cmtProfiles.find(p => p.id === inst.profileId);
        return {
          cmType:           inst.profileId,
          instanceName:     inst.instanceName,
          samplingTime:     inst.samplingTime,
          userProject:      inst.userProject,
          folderId:         folderClientToDb[inst.folderId] ?? null,
          enabledBlocks:    profile?.enabledBlocks || [],
          roleAssignments:  inst.roleAssignments || {},
          // Composite wiring metadata (undefined for plain instances)
          compositeGroupId: inst.compositeGroupId ?? null,
          compositeId:      inst.compositeId      ?? null,
          memberIdx:        inst.memberIdx         ?? null,
        };
      });

      // Stream generation with a live top progress bar. Non-blocking: the user can
      // switch tabs while this runs; the bar lives in top-level App state.
      setGenProgress({ pct: 0, phase: "starting", msg: "Starting generation…" });
      const r = await generateXMLStream({
        projectName: savedProjectName,
        userProjects,
        instances:   payload,
        generatedBy: "", // backend will use process.env.USERNAME
      }, p => setGenProgress(p));
      setResult(r);
      setGenProgress(null);
      setStep(7);   // jump to the Generate tab, which renders the output
    } catch (e) {
      setError(e.message);
      setGenProgress(null);
    }
  }

  function goTo(i) {
    if (i > 0 && !savedProjectName.trim()) {
      setError("Select or create a project first.");
      setStep(0);
      return;
    }
    setError("");
    // Show spinner immediately when navigating to Instances tab (step 5). The
    // grid render is what's slow (2000 rows block the main thread), so we always
    // show it — the effect above clears it after the spinner paints, letting the
    // grid mount on the following frame.
    if (i === 5) {
      setUiLoading("Loading instances...");
    }
    setStep(i);
  }

  return (
    <GlobalLoadingProvider uiLoading={uiLoading} setUiLoading={setUiLoading}>
      <div className="app-main" style={{ fontFamily: "var(--font-sans)", fontSize: 14, color: "var(--color-text-primary)" }}>
        {/* Sidebar Navigation */}
        <Sidebar
          activeStep={step}
          onStepChange={goTo}
          libStatus={libStatus}
          projectName={savedProjectName}
        />

        {/* Main Content Area */}
        <div className="app-content">
          {/* Non-blocking XML-generation progress bar, pinned to the top */}
          <ProgressBar progress={genProgress} />

          {error && (
            <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: "var(--border-radius-md)",
                padding: "8px 12px", marginBottom: "1rem", fontSize: 13, color: "#991B1B" }}>
              <div>{error}</div>
              {errorConflictRows && errorConflictRows.length > 0 && (
                <table style={{ marginTop: 8, borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #FCA5A5" }}>
                      <th style={{ textAlign: "left", padding: "4px 8px" }}>Address</th>
                      <th style={{ textAlign: "left", padding: "4px 8px" }}>Name</th>
                      <th style={{ textAlign: "left", padding: "4px 8px" }}>IP</th>
                      <th style={{ textAlign: "left", padding: "4px 8px" }}>Conflict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errorConflictRows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid #FEE2E2" }}>
                        <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{r.address}</td>
                        <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{r.name || "—"}</td>
                        <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{r.ip || "—"}</td>
                        <td style={{ padding: "4px 8px" }}>{r.reasons.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {uiLoading && <Spinner message={uiLoading} />}

          {step === 0 && (
            <StepProjects libStatus={libStatus} loading={loading}
          savedProjectName={savedProjectName}
          savedProjectId={savedProjectId}
          userProjects={userProjects} setUserProjects={setUserProjects}
          instances={instances} setInstances={setInstances}
          projectConfig={projectConfig} onProjectConfigChange={setProjectConfig}
          onCreateProject={name => {
            setSavedProjectName(name);
            setSavedProjectId(null);
            setInstances([]);
            setUnitInstances([]);
            setUserProjects([]);
            setHierarchy([]);
            setProjectConfig(null);
            setProfiles(prev => prev.map(p => ({ ...p, enabledBlocks: null, subBlocks: undefined })));
          }}
          onLoadProject={loadProjectIntoState}
          setError={setError} />
      )}
          {step === 1 && (
            <StepIOImport
              savedProjectId={savedProjectId}
              cmtProfiles={cmtProfiles}
              compositeCmTypes={compositeCmTypes}
              onPromoted={() => savedProjectId && loadProjectIntoState(savedProjectId)}
              onImportHardware={async (ioImportId, hardwareMappings) => {
                try {
                  const hwImports = await listHwImports(savedProjectId);
                  const hwImport = Array.isArray(hwImports) && hwImports.length > 0 ? hwImports[0] : null;
                  if (!hwImport) {
                    setError('No Hardware import found. Upload a baseline CFG on the HW Config step first, then retry Import Hardware.');
                    return;
                  }
                  await ingestIoRowsIntoHw(hwImport.id, ioImportId);
                  setPendingHwMapping({ hwImportId: hwImport.id, ioImportId, hardwareMappings });
                  setStep(6);
                } catch (e) {
                  setError(e.message);
                }
              }}
              setError={setError} />
          )}
          {step === 2 && (
            <StepLibrary libStatus={libStatus} loading={loading}
              onUpload={handleUpload}
              cmtProfiles={cmtProfiles} ensureLoaded={ensureBlocksLoaded} toggleBlock={toggleBlock}
              onDelete={handleDeleteCmType}
              onCompositesChange={loadCompositeCmTypesList}
              onVarDefaultChange={(cmTypeName, varId, newVal) => {
                setProfiles(prev => prev.map(p => {
                  if (p.id !== cmTypeName || !p.subBlocks) return p;
                  return { ...p, subBlocks: p.subBlocks.map(b => ({
                    ...b,
                    vars: b.vars.map(v => v.id === varId ? { ...v, val: newVal } : v),
                  }))};
                }));
              }}
              onVarValidChange={(cmTypeName, varId, isValid) => {
                setProfiles(prev => prev.map(p => {
                  if (p.id !== cmTypeName || !p.subBlocks) return p;
                  return { ...p, subBlocks: p.subBlocks.map(b => ({
                    ...b,
                    vars: b.vars.map(v => v.id === varId ? { ...v, isValid } : v),
                  }))};
                }));
              }}
              valveCommands={valveCommands}
              onValveCommandsChange={loadValveCommands} />
          )}
          {importDiff && (
            <LibraryImportReview
              diffResult={importDiff}
              onImport={handleImportConfirm}
              onCancel={() => { setImportPreview(null); setImportDiff(null); }} />
          )}
          {step === 3 && (
            <StepUnitTypes
              unitTypes={unitTypes}
              unitInstances={unitInstances}
              cmtProfiles={cmtProfiles}
              compositeCmTypes={compositeCmTypes}
              userProjects={userProjects}
              savedProjectId={savedProjectId}
              ensureLoaded={ensureBlocksLoaded}
              loading={loading}
              setError={setError}
              onUnitTypesChange={loadUnitTypes}
              onExpand={async () => {
                if (!savedProjectId) return;
                setLoading("Generating instances…");
                try {
                  await expandUnitInstances(savedProjectId);
                  await loadProjectIntoState(savedProjectId);
                  loadUnitInstances(savedProjectId);
                } catch (e) { setError(e.message); }
                finally { setLoading(""); }
              }}
              onUnitInstancesChange={() => loadUnitInstances(savedProjectId)}
              unitConnections={unitConnections}
              cmTypeVarCache={cmTypeVarCache}
              onLoadConnections={loadUnitTypeConnections}
              onSaveConnections={saveUnitConnectionsEditor}
            />
          )}
          {step === 4 && (
            <StepHierarchy hierarchy={hierarchy} setHierarchy={setHierarchy}
              instances={instances} setInstances={setInstances}
              savedProjectName={savedProjectName} />
          )}
          {step === 5 && !uiLoading && (
            <StepInstances instances={instances} cmtProfiles={cmtProfiles}
              userProjects={userProjects} savedProjectName={savedProjectName}
              savedProjectId={savedProjectId}
              hierarchy={hierarchy}
              compositeCmTypes={compositeCmTypes}
              addInstance={addInstance} removeInstance={removeInstance}
              updateInstance={updateInstance} updateInstanceRole={updateInstanceRole}
              addCompositeInstances={addCompositeInstances}
              ensureLoaded={ensureBlocksLoaded} loading={loading}
              generating={!!genProgress}
              saveProjectNow={saveProjectNow}
              onGenerate={handleGenerate}
              setError={setError}
              getCompositeCmType={getCompositeCmType}
              extractMemberConnections={extractMemberConnections}
              valveCommands={valveCommands}
              setInstances={setInstances} />
          )}
          {step === 6 && (
            <StepHWConfig
              projectId={savedProjectId}
              pendingHwMapping={pendingHwMapping}
              onPendingHwMappingConsumed={() => setPendingHwMapping(null)}
            />
          )}
          {step === 7 && (
            result ? (
              <StepOutput result={result} onBack={() => setStep(5)} />
            ) : (
              <div style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-secondary)" }}>
                No XML generated yet. Go to the <b>Instances</b> step and click <b>Generate XML</b>.
              </div>
            )
          )}
        </div>
      </div>
    </GlobalLoadingProvider>
  );
}

// ── Step 0: Projects ─────────────────────────────────────────────────────────
function StepProjects({ loading, savedProjectName, savedProjectId,
    userProjects, setUserProjects, instances, setInstances,
    projectConfig, onProjectConfigChange,
    onCreateProject, onLoadProject, setError }) {
  const [projects, setProjects]   = useState([]);
  const [busy, setBusy]           = useState(false);
  const [creating, setCreating]   = useState(false);
  const [newName, setNewName]     = useState("");
  const hasActive = !!savedProjectName.trim();

  async function refresh() {
    try { setProjects(await listProjects()); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { refresh(); }, []);
  // Re-fetch the list whenever the active project name changes — picks up the
  // first auto-save of a newly created project, and rename/overwrite cases.
  useEffect(() => { refresh(); }, [savedProjectName]);

  async function handleDelete(p) {
    if (!window.confirm(`Delete project '${p.name}'?`)) return;
    setBusy(true);
    try { await deleteProject(p.id); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleLoad(p) {
    setBusy(true);
    try { await onLoadProject(p.id); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function submitNew() {
    const name = newName.trim();
    if (!name) { setError("Project name required"); return; }
    if (projects.some(p => p.name === name)
          && !window.confirm(`A project named '${name}' already exists. Continuing will overwrite it on the next change. Proceed?`)) return;
    setCreating(false);
    setNewName("");
    onCreateProject(name);
  }

  // ── User-projects editor (only meaningful once a project is active) ──
  function addUserProject() {
    const next = `AS${String(userProjects.length + 1).padStart(2, "0")}`;
    setUserProjects([...userProjects, next]);
  }
  function updateUserProject(idx, value) {
    const old = userProjects[idx];
    const next = [...userProjects];
    next[idx] = value;
    setUserProjects(next);
    if (old && old !== value) {
        setInstances(prev => prev.map(i => i.userProject === old ? { ...i, userProject: value } : i));
    }
  }
  function removeUserProject(idx) {
    const removed = userProjects[idx];
    if (instances.some(i => i.userProject === removed)
          && !window.confirm(`Some instances are assigned to '${removed}'. Removing it will clear those assignments. Continue?`)) return;
    setUserProjects(userProjects.filter((_, i) => i !== idx));
    setInstances(prev => prev.map(i => i.userProject === removed ? { ...i, userProject: "" } : i));
  }

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Projects</h2>
              <p className="card-subtitle">Resume a saved project or create a new one. Changes save automatically.</p>
            </div>
            {!creating && (
              <Btn primary onClick={() => setCreating(true)} disabled={busy}>
                <i className="ti ti-plus" /> New project
              </Btn>
            )}
          </div>
        </div>

        <div className="card">
          {creating && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: "1rem",
                padding: "10px 12px", border: "0.5px solid var(--color-border-secondary)",
                borderRadius: "var(--border-radius-lg)", background: "var(--color-background-secondary)" }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Project name:</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
                placeholder="e.g. Plant_A"
                onKeyDown={e => { if (e.key === "Enter") submitNew(); if (e.key === "Escape") { setCreating(false); setNewName(""); } }}
                style={{ flex: 1, padding: "5px 10px", border: "0.5px solid var(--color-border-secondary)",
                  borderRadius: "var(--border-radius-md)", fontSize: 13,
                  background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
              <Btn primary onClick={submitNew}>Create</Btn>
              <Btn onClick={() => { setCreating(false); setNewName(""); }}>Cancel</Btn>
            </div>
          )}

          <SLabel text="Saved projects" />
        {projects.length === 0 ? (
          <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
              padding: "1.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13, marginBottom: "1.5rem" }}>
            No saved projects yet — create a new one above.
          </div>
        ) : (
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)",
              overflow: "hidden", marginBottom: "1.5rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 52px 52px 52px 180px 80px",
                padding: "6px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)",
                background: "var(--color-background-secondary)" }}>
              {["Name", "CM", "EM", "EPH", "Updated", ""].map((h, i) => (
                <div key={i} style={{ fontSize: 11, color: "var(--color-text-secondary)",
                    fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</div>
              ))}
            </div>
            {projects.map((p, idx) => {
              const active = p.name === savedProjectName;
              return (
                <div key={p.id} onClick={() => !active && handleLoad(p)}
                  style={{ display: "grid", gridTemplateColumns: "1fr 52px 52px 52px 180px 80px",
                    padding: "8px 12px", alignItems: "center",
                    cursor: active ? "default" : (busy ? "wait" : "pointer"),
                    background: active ? "#EEEDFE" : "transparent",
                    borderBottom: idx < projects.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                  <div>
                    <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 500 }}>
                      {p.name}
                      {active && <span style={{ marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 8,
                        background: "#7F77DD", color: "white", fontWeight: 500, fontFamily: "var(--font-sans)" }}>active</span>}
                    </div>
                    {p.comment && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>{p.comment}</div>}
                  </div>
                  <div style={{ fontSize: 12 }}>{p.cm_count || 0}</div>
                  <div style={{ fontSize: 12 }}>{p.em_count || 0}</div>
                  <div style={{ fontSize: 12 }}>{p.eph_count || 0}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                    {p.updated_at ? new Date(p.updated_at + "Z").toLocaleString() : ""}
                  </div>
                  <button onClick={e => { e.stopPropagation(); handleDelete(p); }}
                    style={{ background: "transparent", border: "none", cursor: "pointer",
                      color: "var(--color-text-secondary)", fontSize: 16, padding: 0, justifySelf: "end" }}>
                    <i className="ti ti-trash" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {hasActive && (
          <>
            <SLabel text={`User projects · ${savedProjectName}`} top />
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>
              One XML will be generated per user project (AS01.xml, AS02.xml, …).
            </div>

            {userProjects.length === 0 ? (
              <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
                  padding: "1.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13, marginBottom: "1rem" }}>
                No user projects yet — add one below
              </div>
            ) : (
              <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)",
                  overflow: "hidden", marginBottom: "1rem" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 32px",
                    padding: "6px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)",
                    background: "var(--color-background-secondary)" }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500,
                    textTransform: "uppercase", letterSpacing: "0.04em" }}>User project name</div>
                  <div />
                </div>
                {userProjects.map((name, idx) => (
                  <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 32px",
                      padding: "6px 12px", alignItems: "center",
                      borderBottom: idx < userProjects.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                    <input value={name} onChange={e => updateUserProject(idx, e.target.value)}
                      style={{ width: "100%", padding: "4px 8px", border: "0.5px solid var(--color-border-secondary)",
                        borderRadius: "var(--border-radius-md)", fontSize: 12, fontFamily: "var(--font-mono)",
                        background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
                    <button onClick={() => removeUserProject(idx)}
                      style={{ background: "transparent", border: "none", cursor: "pointer",
                        color: "var(--color-text-secondary)", fontSize: 16, padding: 0, marginLeft: 6 }}>
                      <i className="ti ti-trash" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <Btn onClick={addUserProject}><i className="ti ti-plus" /> Add user project</Btn>
            </div>

            <Pcs7ConfigPanel
              projectId={savedProjectId}
              config={projectConfig}
              onConfigChange={onProjectConfigChange}
              setError={setError} />
          </>
          )}

          {loading && (
            <div style={{ textAlign: "center", marginTop: 12, fontSize: 13, color: "var(--color-text-secondary)" }}>
              {loading}
            </div>
          )}
        </div>
    </div>
  );
}

// ── PCS7 Config Panel ────────────────────────────────────────────────────────
const PCS7_CONFIG_FIELDS = [
  { key: "project_name",    label: "Project Name"    },
  { key: "project_id_val",  label: "Project ID"      },
  { key: "device_name",     label: "Device Name"     },
  { key: "device_id",       label: "Device ID"       },
  { key: "cpu_id",          label: "CPU ID"          },
  { key: "process_cell",    label: "Process Cell"    },
  { key: "process_cell_id", label: "Process Cell ID" },
  { key: "unit_name",       label: "Unit Name"       },
  { key: "unit_id",         label: "Unit ID"         },
  { key: "cm_folder_id",    label: "CM Folder ID"    },
  { key: "export_user",     label: "Export User"     },
  { key: "unit_author",     label: "Unit Author"     },
];

function Pcs7ConfigPanel({ projectId, config, onConfigChange, setError }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft]       = useState(null);  // editing state
  const [saving, setSaving]     = useState(false);
  const [parseMsg, setParseMsg] = useState("");
  const fileRef = useRef(null);

  const hasConfig = config && Object.values(config).some(v => v && typeof v === "string" && v.length > 0);

  function startEdit() {
    setDraft(PCS7_CONFIG_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: config?.[f.key] || "" }), {}));
  }
  function cancelEdit() { setDraft(null); }

  async function handleSave() {
    if (!projectId || !draft) return;
    setSaving(true);
    try {
        const saved = await saveProjectConfig(projectId, draft);
        onConfigChange(saved);
        setDraft(null);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function handleParseXml(e) {
    const file = e.target.files?.[0];
    if (!file || !projectId) return;
    setParseMsg("Parsing…");
    try {
        const { config: saved, missing } = await parseProjectXml(projectId, file);
        onConfigChange(saved);
        setParseMsg(missing.length
          ? `Loaded. Not found in XML: ${missing.join(", ")}`
          : "All fields extracted successfully.");
    } catch (err) {
        setError(err.message);
        setParseMsg("");
    } finally {
        e.target.value = "";
    }
  }

  if (!projectId) return null;

  return (
    <div style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <button onClick={() => setExpanded(x => !x)}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
              cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 500,
              color: "var(--color-text-primary)" }}>
            <i className={`ti ti-chevron-${expanded ? "down" : "right"}`} style={{ fontSize: 12 }} />
            PCS7 Project Config
            {hasConfig && !expanded && (
              <span style={{ fontSize: 11, marginLeft: 4, color: "var(--color-text-secondary)", fontWeight: 400 }}>
                ({config.project_name || config.device_name || "configured"})
              </span>
            )}
            {!hasConfig && (
              <span style={{ fontSize: 11, marginLeft: 4, color: "#D97706", fontWeight: 400 }}>
                — using default IDs
              </span>
            )}
          </button>
        </div>

        {expanded && (
          <div style={{ border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
              padding: "12px 14px", background: "var(--color-background-secondary)" }}>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
              Upload a PCS7 SimaticML export to fill in project-level hardware IDs automatically,
              or edit fields manually. These IDs are written into the generated XML.
            </div>

            {/* Upload row */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <input ref={fileRef} type="file" accept=".xml,.XML" style={{ display: "none" }}
                onChange={handleParseXml} />
              <Btn onClick={() => fileRef.current?.click()}>
                <i className="ti ti-upload" /> Upload PCS7 XML
              </Btn>
              {parseMsg && (
                <span style={{ fontSize: 12, color: parseMsg.includes("Not found") ? "#D97706" : "#166534" }}>
                  {parseMsg}
                </span>
              )}
            </div>

            {/* Field table */}
            {draft ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "160px 1fr",
                    border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)",
                    overflow: "hidden", marginBottom: 10 }}>
                  {PCS7_CONFIG_FIELDS.map((f, idx) => (
                    <React.Fragment key={f.key}>
                      <div style={{ padding: "5px 10px", fontSize: 12,
                          color: "var(--color-text-secondary)", fontWeight: 500,
                          background: "var(--color-background-secondary)",
                          borderBottom: idx < PCS7_CONFIG_FIELDS.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                        {f.label}
                      </div>
                      <div style={{ padding: "3px 8px",
                          borderLeft: "0.5px solid var(--color-border-tertiary)",
                          borderBottom: idx < PCS7_CONFIG_FIELDS.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                        <input value={draft[f.key] || ""} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                          style={{ width: "100%", padding: "3px 6px", fontSize: 12, fontFamily: "var(--font-mono)",
                            border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-sm)",
                            background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
                      </div>
                    </React.Fragment>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn primary onClick={handleSave} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Btn>
                  <Btn onClick={cancelEdit}>Cancel</Btn>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "160px 1fr",
                    border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)",
                    overflow: "hidden", marginBottom: 10 }}>
                  {PCS7_CONFIG_FIELDS.map((f, idx) => {
                    const val = config?.[f.key];
                    return (
                      <React.Fragment key={f.key}>
                        <div style={{ padding: "5px 10px", fontSize: 12,
                            color: "var(--color-text-secondary)", fontWeight: 500,
                            background: "var(--color-background-secondary)",
                            borderBottom: idx < PCS7_CONFIG_FIELDS.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                          {f.label}
                        </div>
                        <div style={{ padding: "5px 10px", fontSize: 12, fontFamily: "var(--font-mono)",
                            color: val ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                            borderLeft: "0.5px solid var(--color-border-tertiary)",
                            borderBottom: idx < PCS7_CONFIG_FIELDS.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                          {val || <em style={{ fontStyle: "italic" }}>— default</em>}
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
                <Btn onClick={startEdit}><i className="ti ti-edit" /> Edit</Btn>
              </>
            )}
          </div>
        )}
    </div>
  );
}

// ── Step 2: Library ──────────────────────────────────────────────────────────
const LIBRARY_SUBTABS = [
  { key: "upload",    label: "Upload Library"       },
  { key: "config",    label: "Type Configuration"   },
  { key: "composite", label: "Composite CM Types"   },
  { key: "commands",  label: "Mode Commands"        },
];

function StepLibrary({ libStatus, loading, onUpload, cmtProfiles, ensureLoaded, toggleBlock, onDelete, onVarDefaultChange, onVarValidChange, onCompositesChange, valveCommands, onValveCommandsChange }) {
  const [libSubTab, setLibSubTab] = useState("upload");

  return (
    <div>
        {/* Sub-tab bar */}
        <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: "1.5rem" }}>
          {LIBRARY_SUBTABS.map(t => {
            const active = libSubTab === t.key;
            return (
              <button key={t.key} onClick={() => setLibSubTab(t.key)}
                style={{ padding: "7px 18px", border: "none", background: "transparent",
                  cursor: "pointer", fontSize: 13, fontWeight: active ? 500 : 400,
                  color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                  borderBottom: active ? "2px solid var(--color-text-primary)" : "2px solid transparent",
                  marginBottom: -1 }}>
                {t.label}
              </button>
            );
          })}
        </div>

        {libSubTab === "upload" && (
          <LibraryUploadPanel
            libStatus={libStatus} loading={loading} onUpload={onUpload} />
        )}
        {libSubTab === "config" && (
          <CmtPanel
            cmtProfiles={cmtProfiles} ensureLoaded={ensureLoaded}
            toggleBlock={toggleBlock} onDelete={onDelete}
            onVarDefaultChange={onVarDefaultChange}
            onVarValidChange={onVarValidChange} />
        )}
        {libSubTab === "composite" && (
          <CompositeCmPanel cmtProfiles={cmtProfiles} ensureLoaded={ensureLoaded} onCompositesChange={onCompositesChange} valveCommands={valveCommands} />
        )}
        {libSubTab === "commands" && (
          <ModeCommandsPanel valveCommands={valveCommands} onValveCommandsChange={onValveCommandsChange} />
        )}
    </div>
  );
}

// ── Upload Library sub-tab ────────────────────────────────────────────────────
function LibraryUploadPanel({ libStatus, loading, onUpload }) {
  const fileRef = useRef();
  const loaded  = libStatus?.cm_count > 0;

  return (
    <div>
        {loaded && (
          <div style={{ background: "#DCFCE7", border: "1px solid #86EFAC", borderRadius: "var(--border-radius-md)",
              padding: "10px 14px", marginBottom: "1rem" }}>
            <span style={{ fontWeight: 500, color: "#166534" }}>
              ✓ Library loaded — {libStatus.cm_count} CM/EM/EPH types
            </span>
            <span style={{ fontSize: 12, color: "#15803D", marginLeft: 10 }}>
              Last updated: {new Date(libStatus.last_loaded).toLocaleString()}
            </span>
          </div>
        )}
        <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
            padding: "2.5rem 2rem", textAlign: "center", cursor: "pointer" }}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onUpload(f); }}>
          <i className="ti ti-file-code" style={{ fontSize: 32, color: "var(--color-text-secondary)", display: "block", marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 500 }}>{loaded ? "Reload SIE_LIB.XML" : "Drop SIE_LIB.XML here"}</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
            {loaded ? "Upload a new version to replace the current library" : "Parsed once and stored in database — never needed again"}
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".xml,.XML" style={{ display: "none" }}
          onChange={e => e.target.files[0] && onUpload(e.target.files[0])} />
        {loading && (
          <div style={{ textAlign: "center", marginTop: 12, fontSize: 13, color: "var(--color-text-secondary)" }}>
            {loading}
          </div>
        )}
    </div>
  );
}

// ── Type Configuration sub-tab ────────────────────────────────────────────────
const LIB_TABS = [
  { key: "all", label: "All" },
  { key: "ControlModule",   label: "CMT" },
  { key: "EquipmentModule", label: "EMT" },
  { key: "EquipmentPhase",  label: "EPH" },
];

const DETAIL_TABS = [
  { key: "blocks",  label: "Blocks"  },
  { key: "inputs",  label: "Inputs"  },
  { key: "outputs", label: "Outputs" },
];

function CmtPanel({ cmtProfiles, ensureLoaded, toggleBlock, onDelete, onVarDefaultChange, onVarValidChange }) {
  const [search, setSearch]         = useState("");
  const [libTab, setLibTab]         = useState("all");
  const [selected, setSelected]     = useState(cmtProfiles[0]?.id || "");
  const [loadingBlocks, setLoading] = useState(false);
  const [detailTab, setDetailTab]   = useState("blocks");

  const byType = libTab === "all"
    ? cmtProfiles
    : cmtProfiles.filter(p => p.libType === libTab);
  const filtered = byType.filter(p => p.cmType.toLowerCase().includes(search.toLowerCase()));
  const profile  = cmtProfiles.find(p => p.id === selected);

  async function selectCM(id) {
    setSelected(id);
    const p = cmtProfiles.find(x => x.id === id);
    if (!p?.subBlocks) {
        setLoading(true);
        await ensureLoaded(id);
        setLoading(false);
    }
  }

  useEffect(() => {
    if (selected) selectCM(selected);
  }, []);

  const reqBlocks = profile?.subBlocks?.filter(b => !b.optional) || [];
  const optBlocks = profile?.subBlocks?.filter(b => b.optional)  || [];

  const allVars = profile?.subBlocks?.flatMap(b =>
    b.vars.map(v => ({ ...v, blockName: b.name }))
  ) || [];
  const inputVars  = allVars.filter(v => /input/i.test(v.dir));
  const outputVars = allVars.filter(v => /output/i.test(v.dir));

  if (!cmtProfiles.length) {
    return (
        <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
            padding: "2.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
          No library loaded — upload SIE_LIB.XML first.
        </div>
    );
  }

  return (
    <div>
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>CMT block configuration</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            Toggle optional blocks per CM type. Data is loaded from the database.
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", gap: 12, height: "calc(100vh - 200px)" }}>
          {/* CM list */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", flexShrink: 0 }}>
              {LIB_TABS.map(t => {
                const count = t.key === "all"
                  ? cmtProfiles.length
                  : cmtProfiles.filter(p => p.libType === t.key).length;
                const active = libTab === t.key;
                return (
                  <button key={t.key} onClick={() => setLibTab(t.key)}
                    style={{ flex: 1, padding: "5px 4px", border: "none", background: "transparent",
                      cursor: "pointer", fontSize: 11, fontWeight: active ? 600 : 400,
                      color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                      borderBottom: active ? "2px solid var(--color-text-primary)" : "2px solid transparent",
                      marginBottom: -1 }}>
                    {t.label}
                    <span style={{ marginLeft: 3, fontSize: 10, opacity: 0.7 }}>({count})</span>
                  </button>
                );
              })}
            </div>
            <div style={{ padding: "6px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", flexShrink: 0 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter CMs…"
                style={{ width: "100%", padding: "4px 8px", border: "0.5px solid var(--color-border-secondary)",
                  borderRadius: "var(--border-radius-md)", fontSize: 12,
                  background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {filtered.map(p => {
                const optOn = p.enabledBlocks?.filter(b => p.subBlocks?.find(s => s.name === b && s.optional)).length || 0;
                return (
                  <div key={p.id} onClick={() => selectCM(p.id)}
                    style={{ padding: "7px 10px", cursor: "pointer", borderBottom: "0.5px solid var(--color-border-tertiary)",
                      background: selected === p.id ? "#EEEDFE" : "transparent",
                      display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, fontFamily: "var(--font-mono)" }}>{p.cmType}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>
                        {p.subBlocks ? `${optOn}/${p.optionalBlocks} optional on` : `${p.optionalBlocks} optional`}
                      </div>
                    </div>
                    {onDelete && (
                      <button onClick={e => { e.stopPropagation(); onDelete(p.cmType); }}
                        title="Remove from library"
                        style={{ flexShrink: 0, border: "none", background: "transparent", cursor: "pointer",
                          padding: "2px 4px", borderRadius: "var(--border-radius-md)",
                          color: "var(--color-text-secondary)", fontSize: 13, lineHeight: 1 }}>
                        <i className="ti ti-trash" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Detail panel with sub-tabs */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)",
              display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)",
                background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-lg) var(--border-radius-lg) 0 0",
                flexShrink: 0 }}>
              {DETAIL_TABS.map(t => {
                const count = t.key === "blocks"
                  ? (profile?.subBlocks?.length ?? 0)
                  : t.key === "inputs" ? inputVars.length : outputVars.length;
                const active = detailTab === t.key;
                return (
                  <button key={t.key} onClick={() => setDetailTab(t.key)}
                    style={{ padding: "6px 14px", border: "none", background: "transparent",
                      cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400,
                      color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                      borderBottom: active ? "2px solid var(--color-text-primary)" : "2px solid transparent",
                      marginBottom: -1 }}>
                    {t.label}
                    {profile?.subBlocks && (
                      <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.65 }}>({count})</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto", padding: detailTab === "blocks" ? "1rem 1.25rem" : 0 }}>
              {loadingBlocks ? (
                <div style={{ color: "var(--color-text-secondary)", fontSize: 13, padding: "1rem 1.25rem" }}>Loading…</div>
              ) : !profile?.subBlocks ? (
                <div style={{ color: "var(--color-text-secondary)", fontSize: 13, padding: "1rem 1.25rem" }}>Select a CM type</div>
              ) : (
                <>
                  {detailTab === "blocks" && (
                    <>
                      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 2 }}>{profile.cmType}</div>
                      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: "1rem" }}>
                        {profile.comment}{profile.samplingTime ? ` · ${profile.samplingTime} ms` : ""}
                      </div>
                      <SLabel text={`Required (${reqBlocks.length})`} />
                      {reqBlocks.map(b => <BlockRow key={b.name} block={b} on={true} required={true} onToggle={() => {}} />)}
                      <SLabel text={`Optional (${optBlocks.length})`} top />
                      {optBlocks.map(b => (
                        <BlockRow key={b.name} block={b} on={profile.enabledBlocks?.includes(b.name)}
                          required={false} onToggle={() => toggleBlock(profile.id, b.name)} />
                      ))}
                    </>
                  )}
                  {(detailTab === "inputs" || detailTab === "outputs") && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                      <div style={{ padding: "0.75rem 1.25rem", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12, fontWeight: 500, flexShrink: 0, color: "var(--color-text-secondary)" }}>
                        {detailTab === "inputs" ? "Input Parameters" : "Output Parameters"}
                      </div>
                      <div style={{ flex: 1, minHeight: 0 }}>
                        <VarTableErrorBoundary key={`${profile.id}-${detailTab}`}>
                          <VarTable
                            vars={detailTab === "inputs" ? inputVars : outputVars}
                            cmTypeName={profile.id}
                            editable={detailTab === "inputs"}
                            showValid={true}
                            onVarDefaultChange={(varId, newVal) => onVarDefaultChange?.(profile.id, varId, newVal)}
                            onVarValidChange={(varId, isValid) => onVarValidChange?.(profile.id, varId, isValid)} />
                        </VarTableErrorBoundary>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
    </div>
  );
}

class VarTableErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("VarTable crashed:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "1rem 1.25rem", color: "#DC2626", fontSize: 12, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" }}>
          Error rendering parameters:{"\n"}{String(this.state.error?.message || this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

function VarTable({ vars, cmTypeName, editable, showValid, onVarDefaultChange, onVarValidChange }) {
  const gridRef = useRef(null);
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState({});
  const [validSaving, setValidSaving] = useState({});

  if (!vars || !vars.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: 13, color: "var(--color-text-secondary)" }}>
        No parameters found.
      </div>
    );
  }

  async function commitVal(v, newVal) {
    if (newVal === (v.val || "")) { setDrafts(d => { const n = {...d}; delete n[v.id]; return n; }); return; }
    setSaving(s => ({ ...s, [v.id]: true }));
    try {
        await patchVarDefault(cmTypeName, v.id, newVal);
        onVarDefaultChange?.(v.id, newVal);
    } catch (_) {}
    finally {
        setSaving(s => { const n = {...s}; delete n[v.id]; return n; });
        setDrafts(d => { const n = {...d}; delete n[v.id]; return n; });
    }
  }

  async function toggleValid(v) {
    if (!v.id) return;
    const next = !v.isValid;
    setValidSaving(s => ({ ...s, [v.id]: true }));
    try {
        await patchVarValid(cmTypeName, v.id, next);
        onVarValidChange?.(v.id, next);
    } catch (_) {}
    finally { setValidSaving(s => { const n = {...s}; delete n[v.id]; return n; }); }
  }

  const theme = useMemo(() => themeQuartz.withParams({
    fontSize: 12, rowHeight: 36, headerHeight: 36,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    accentColor: '#0C447C', browserColorScheme: 'light',
  }), []);

  const defaultColDef = useMemo(() => ({
    sortable: true, resizable: true, suppressMovable: false,
  }), []);

  const columnDefs = useMemo(() => {
    const isInput = vars.length > 0 && /input/i.test(vars[0].dir);
    const cols = [
      {
        headerName: 'Block', field: 'blockName',
        filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 120, flex: 1,
        cellStyle: { fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--color-text-secondary)' },
      },
      {
        headerName: 'Parameter', field: 'name',
        filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 140, flex: 1.2,
        cellStyle: { fontFamily: 'ui-monospace, monospace', fontWeight: 500 },
      },
      {
        headerName: 'Data Type', field: 'dtype',
        filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 100, flex: 0.8,
        cellStyle: { fontSize: 11, color: 'var(--color-text-secondary)' },
      },
      {
        headerName: 'Dir', field: 'dir',
        filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 70, flex: 0.6,
        cellRenderer: p => (
          <span style={{
            padding: '1px 5px', borderRadius: 4, fontSize: 10, fontWeight: 500,
            background: isInput ? '#DBEAFE' : '#DCFCE7',
            color: isInput ? '#1D4ED8' : '#166534',
          }}>
            {p.value || '—'}
          </span>
        ),
      },
      {
        headerName: 'Default', field: 'val',
        filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 110, flex: 1,
        cellRenderer: p => {
          const v = p.data;
          const isDraft = v.id in drafts;
          const draftVal = isDraft ? drafts[v.id] : (v.val || '');
          const isSaving = !!saving[v.id];
          const canEdit = editable && !!v.id;

          if (canEdit) {
            return (
              <input
                value={draftVal}
                onChange={e => setDrafts(d => ({ ...d, [v.id]: e.target.value }))}
                onFocus={() => { if (!isDraft) setDrafts(d => ({ ...d, [v.id]: v.val || '' })); }}
                onBlur={e => commitVal(v, e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.target.blur();
                  if (e.key === 'Escape') { setDrafts(d => { const n={...d}; delete n[v.id]; return n; }); e.target.blur(); }
                }}
                disabled={isSaving}
                title="Click to edit default value"
                style={{
                  width: '100%', padding: '2px 5px', fontSize: 11, fontFamily: 'var(--font-mono)',
                  border: isDraft ? '1px solid #7F77DD' : '1px solid transparent',
                  borderRadius: '4px', background: isDraft ? 'var(--color-background-primary)' : 'transparent',
                  color: draftVal ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  cursor: 'text', outline: 'none', opacity: isSaving ? 0.5 : 1
                }}
              />
            );
          }
          return <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>{v.val || '—'}</div>;
        },
      },
    ];

    if (showValid) {
      cols.push({
        headerName: '', colId: 'valid', sortable: false, filter: false, resizable: false,
        width: 70, maxWidth: 70,
        cellRenderer: p => {
          const v = p.data;
          const isVSaving = !!validSaving[v.id];
          const isInputVar = /input/i.test(v.dir);
          return (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                onClick={() => toggleValid(v)}
                disabled={isVSaving || !v.id}
                title={v.isValid ? 'Remove from wiring palette' : 'Mark as available for wiring'}
                style={{
                  border: 'none', background: 'transparent', cursor: v.id ? 'pointer' : 'default',
                  padding: '2px 4px', fontSize: 14, lineHeight: 1,
                  opacity: isVSaving ? 0.4 : 1,
                  color: v.isValid ? (isInputVar ? '#1D4ED8' : '#166534') : 'var(--color-text-secondary)',
                }}
              >
                {v.isValid
                  ? <i className="ti ti-plug-connected" />
                  : <i className="ti ti-plug" />}
              </button>
            </div>
          );
        },
      });
    }

    cols.push({
      headerName: 'Comment', field: 'comment',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, flex: 1.5,
      cellStyle: { fontSize: 11, color: 'var(--color-text-secondary)' },
    });

    return cols;
  }, [drafts, saving, validSaving, editable, showValid, vars]);

  const getRowId = useCallback(p => String(p.data.id || p.data.name), []);

  return (
    <div className="ig-root" style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
      <AgGridReact
        ref={gridRef}
        theme={theme}
        domLayout="autoHeight"
        rowData={vars}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowId={getRowId}
        animateRows={false}
      />
    </div>
  );
}

// ── Mode Commands sub-tab ─────────────────────────────────────────────────────
function ModeCommandsPanel({ valveCommands, onValveCommandsChange }) {
  // Local draft: array of { name, value }
  const [draft, setDraft]   = useState(null);  // null = not editing
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState("");

  function startEdit() {
    setDraft((valveCommands || []).map(c => ({ name: c.name, value: c.value })));
    setErr("");
  }
  function cancelEdit() { setDraft(null); setErr(""); }

  function addRow() {
    setDraft(d => [...d, { name: "", value: 0 }]);
  }
  function removeRow(i) {
    setDraft(d => d.filter((_, j) => j !== i));
  }
  function updateRow(i, field, rawVal) {
    setDraft(d => d.map((r, j) => j !== i ? r : {
        ...r,
        [field]: field === "value" ? (parseInt(rawVal) || 0) : rawVal,
    }));
  }

  async function handleSave() {
    setErr("");
    for (const r of draft) {
        if (!r.name.trim()) { setErr("All rows must have a name"); return; }
    }
    setBusy(true);
    try {
        await saveValveCommands(draft.map(r => ({ name: r.name.trim().toUpperCase(), value: r.value })));
        setDraft(null);
        if (onValveCommandsChange) await onValveCommandsChange();
    } catch (e) {
        setErr(e.message);
    } finally { setBusy(false); }
  }

  const inputSx = { padding: "3px 6px", border: "0.5px solid var(--color-border-secondary)",
    borderRadius: "var(--border-radius-md)", fontSize: 12, boxSizing: "border-box",
    background: "var(--color-background-primary)", color: "var(--color-text-primary)" };

  const rows = draft ?? (valveCommands || []).map(c => ({ name: c.name, value: c.value }));

  return (
    <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Mode Commands</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
              Define the named command → integer value lookup used in matrix cell dropdowns.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {draft ? (
              <>
                <Btn onClick={addRow} style={{ fontSize: 11 }}><i className="ti ti-plus" /> Add row</Btn>
                <Btn onClick={handleSave} disabled={busy} style={{ fontSize: 11, background: "var(--color-primary)", color: "#fff" }}>
                  {busy ? "Saving…" : "Save"}
                </Btn>
                <Btn onClick={cancelEdit} style={{ fontSize: 11 }}>Cancel</Btn>
              </>
            ) : (
              <Btn onClick={startEdit} style={{ fontSize: 11 }}><i className="ti ti-pencil" /> Edit</Btn>
            )}
          </div>
        </div>

        {err && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 8 }}>{err}</div>}

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%", maxWidth: 480 }}>
            <thead>
              <tr style={{ background: "var(--color-background-secondary)" }}>
                <th style={{ padding: "4px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", textAlign: "left", fontWeight: 600 }}>Command Name</th>
                <th style={{ padding: "4px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", textAlign: "center", fontWeight: 600, width: 90 }}>Value</th>
                {draft && <th style={{ width: 30 }} />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)",
                    background: i % 2 === 0 ? "transparent" : "var(--color-background-secondary)" }}>
                  <td style={{ padding: "3px 8px" }}>
                    {draft ? (
                      <input value={r.name} onChange={e => updateRow(i, "name", e.target.value)}
                        placeholder="e.g. OPEN" style={{ ...inputSx, width: "100%", fontFamily: "var(--font-mono)" }} />
                    ) : (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.name}</span>
                    )}
                  </td>
                  <td style={{ padding: "3px 8px", textAlign: "center" }}>
                    {draft ? (
                      <input type="number" value={r.value} onChange={e => updateRow(i, "value", e.target.value)}
                        style={{ ...inputSx, width: 80, textAlign: "center", fontFamily: "var(--font-mono)" }} />
                    ) : (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.value}</span>
                    )}
                  </td>
                  {draft && (
                    <td style={{ padding: "3px 4px", textAlign: "center" }}>
                      <button onClick={() => removeRow(i)}
                        style={{ border: "none", background: "transparent", cursor: "pointer", color: "#DC2626", fontSize: 13 }}>
                        <i className="ti ti-x" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={draft ? 3 : 2} style={{ padding: "1rem", textAlign: "center", fontSize: 12, color: "var(--color-text-secondary)" }}>
                    No commands defined — click Edit to add entries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
    </div>
  );
}

// ── Composite CM Types sub-tab ────────────────────────────────────────────────
const EMPTY_COMPOSITE = { name: "", description: "", members: [], is_matrix: false, matrixColumns: [], matrixModes: [] };
const EMPTY_MEMBER    = { cm_type_name: "", hierarchy_folder: "", name_prefix: "", name_suffix: "", scope: "unit" };

function CompositeCmPanel({ cmtProfiles, ensureLoaded, onCompositesChange, valveCommands }) {
  const [composites, setComposites]   = useState([]);
  const [selectedId, setSelectedId]   = useState(null);
  const [editing, setEditing]         = useState(null);   // draft being edited
  const [busy, setBusy]               = useState(false);
  const [localErr, setLocalErr]       = useState("");
  // Cache of valid vars per cm type name: { [cmTypeName]: { inputs: [], outputs: [] } }
  const [validVarsCache, setValidVarsCache] = useState({});
  // Add-connection controls
  const [wire, setWire] = useState({ type: "interconnection", fromIdx: "", fromVar: "", toIdx: "", toVar: "", staticValue: "", valueMode: "static", column: "", prefix: "", suffix: "" });

  // IO Connection state — rules per member cm_type_name, keyed by cm_type_name
  // { [cmTypeName]: { cmType, rules, blocks, vars } }
  const [ioRulesCache, setIoRulesCache]   = useState({});
  // New-rule draft: paramKey encodes "block>>var" of the selected input parameter
  const [ioWire, setIoWire] = useState({ memberIdx: "", paramKey: "", suffix: "", prefix: "", required: true });
  const [ioErr, setIoErr]                 = useState("");

  // Column-name suggestions for derived Value connections, sourced from the most
  // recently uploaded IO import across all projects (this panel has no single project
  // in scope). Column names are stored as free strings, so this only seeds the
  // dropdown — actual resolution always uses whichever import the target project has.
  const [ioColumns, setIoColumns] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const latest = await getLatestIoImport();
        if (latest?.id) {
          const { headers } = await getIOHeaders(latest.id);
          setIoColumns(headers || []);
        }
      } catch { setIoColumns([]); }
    })();
  }, []);

  useEffect(() => { load(); }, []);

  // Sync valid vars cache from already-loaded profiles (e.g. user visited Library tab first)
  useEffect(() => {
    const updates = {};
    for (const p of cmtProfiles) {
        if (!p.subBlocks) continue;
        const allVars = p.subBlocks.flatMap(b => b.vars.map(v => ({ ...v, blockName: b.name })));
        updates[p.id] = {
          inputs:  allVars.filter(v => /input/i.test(v.dir) && v.isValid),
          outputs: allVars.filter(v => /output/i.test(v.dir) && v.isValid),
        };
    }
    if (Object.keys(updates).length) setValidVarsCache(prev => ({ ...prev, ...updates }));
  }, [cmtProfiles]);

  async function load() {
    try { setComposites(await listCompositeCmTypes()); } catch (e) { setLocalErr(e.message); }
  }

  function startNew() {
    setSelectedId(null);
    setEditing({ ...EMPTY_COMPOSITE, members: [], connections: [], matrixColumns: [], matrixModes: [] });
    setWire({ type: "interconnection", fromIdx: "", fromVar: "", toIdx: "", toVar: "", staticValue: "", valueMode: "static", column: "", prefix: "", suffix: "" });
    setIoWire({ memberIdx: "", paramKey: "", suffix: "", prefix: "", required: true });
    setIoErr("");
    setLocalErr("");
  }

  async function ensureValidVars(cmTypeNames) {
    const missing = cmTypeNames.filter(n => n && !validVarsCache[n]);
    if (!missing.length) return;
    const results = await Promise.all(missing.map(n => ensureLoaded?.(n).catch(() => null)));
    const updates = {};
    missing.forEach((n, i) => {
        const profile = results[i];
        if (!profile?.subBlocks) return;
        const allVars = profile.subBlocks.flatMap(b => b.vars.map(v => ({ ...v, blockName: b.name })));
        updates[n] = {
          inputs:  allVars.filter(v => /input/i.test(v.dir) && v.isValid),
          outputs: allVars.filter(v => /output/i.test(v.dir) && v.isValid),
        };
    });
    if (Object.keys(updates).length) setValidVarsCache(prev => ({ ...prev, ...updates }));
  }

  async function loadIoRulesForMembers(members) {
    const missing = members.filter(m => m.cm_type_name && !ioRulesCache[m.cm_type_name]);
    if (!missing.length) return;
    const results = await Promise.all(
        missing.map(m =>
          getIoConnections(
            // We need the lib_cm_types.id — look it up from cmtProfiles
            cmtProfiles.find(p => p.cmType === m.cm_type_name)?.id
          ).catch(() => null)
        )
    );
    const updates = {};
    missing.forEach((m, i) => {
        if (results[i]) updates[m.cm_type_name] = results[i];
    });
    if (Object.keys(updates).length) setIoRulesCache(prev => ({ ...prev, ...updates }));
  }

  async function selectComposite(id) {
    setSelectedId(id);
    setLocalErr("");
    setWire({ type: "interconnection", fromIdx: "", fromVar: "", toIdx: "", toVar: "", staticValue: "", valueMode: "static", column: "", prefix: "", suffix: "" });
    try {
        const detail = await getCompositeCmType(id);
        const members = detail.members || [];
        setEditing({
          name:          detail.name,
          description:   detail.description || "",
          members,
          connections:   detail.connections || [],
          is_matrix:     !!detail.is_matrix,
          matrixColumns: detail.matrixColumns || [],
          matrixModes:   (detail.matrixModes || []).map(m => ({
            mode_nr:   m.mode_nr,
            mode_name: m.mode_name,
            cells:     m.cells || {},
          })),
        });
        await ensureValidVars(members.map(m => m.cm_type_name).filter(Boolean));
        await loadIoRulesForMembers(members);
    } catch (e) { setLocalErr(e.message); }
  }

  async function handleSave() {
    if (!editing?.name?.trim()) { setLocalErr("Name is required"); return; }
    if (!editing.members.length) { setLocalErr("Add at least one CM type member"); return; }
    const invalidMember = editing.members.find(m => !m.cm_type_name.trim());
    if (invalidMember) { setLocalErr("All members must have a CM type selected"); return; }
    if (editing.is_matrix) {
        if (!editing.matrixColumns?.length) { setLocalErr("Add at least one valve column"); return; }
        if (!editing.matrixModes?.length) { setLocalErr("Add at least one mode row"); return; }
    }

    setBusy(true);
    setLocalErr("");
    try {
        const payload = {
          name:          editing.name.trim(),
          description:   editing.description.trim(),
          is_matrix:     !!editing.is_matrix,
          members:       editing.members,
          connections:   editing.connections || [],
          matrixColumns: editing.is_matrix ? (editing.matrixColumns || []) : [],
          matrixModes:   editing.is_matrix ? (editing.matrixModes || []) : [],
        };
        if (selectedId) {
          await updateCompositeCmType(selectedId, payload);
        } else {
          const r = await createCompositeCmType(payload);
          setSelectedId(r.id);
        }
        await load();
        onCompositesChange?.();
    } catch (e) { setLocalErr(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(id) {
    const comp = composites.find(c => c.id === id);
    if (!window.confirm(`Delete composite "${comp?.name}"?`)) return;
    setBusy(true);
    try {
        await deleteCompositeCmType(id);
        if (selectedId === id) { setSelectedId(null); setEditing(null); }
        await load();
        onCompositesChange?.();
    } catch (e) { setLocalErr(e.message); }
    finally { setBusy(false); }
  }

  function addMember() {
    setEditing(prev => ({ ...prev, members: [...prev.members, { ...EMPTY_MEMBER }] }));
  }

  function updateMember(idx, key, value) {
    setEditing(prev => {
        const members = prev.members.map((m, i) => i === idx ? { ...m, [key]: value } : m);
        if (key === "cm_type_name" && value) {
          // Load valid vars and IO rules for the newly selected type
          ensureValidVars([value]);
          loadIoRulesForMembers([{ cm_type_name: value }]);
          // Drop connections that reference this member's old type variables
          const connections = (prev.connections || []).filter(c => c.from_member_idx !== idx && c.to_member_idx !== idx);
          return { ...prev, members, connections };
        }
        return { ...prev, members };
    });
  }

  function removeMember(idx) {
    setEditing(prev => ({
        ...prev,
        members: prev.members.filter((_, i) => i !== idx),
        connections: (prev.connections || []).filter(c => c.from_member_idx !== idx && c.to_member_idx !== idx),
    }));
  }

  function moveMember(idx, dir) {
    setEditing(prev => {
        const members = [...prev.members];
        const target = idx + dir;
        if (target < 0 || target >= members.length) return prev;
        [members[idx], members[target]] = [members[target], members[idx]];
        return { ...prev, members };
    });
  }

  function addConnection() {
    const { type, fromIdx, fromVar, toIdx, toVar, staticValue, valueMode, column, prefix, suffix } = wire;
    if (toIdx === "" || !toVar) return;
    if (type === "interconnection") {
        if (fromIdx === "" || !fromVar) return;
        const fi = parseInt(fromIdx), ti = parseInt(toIdx);
        if (fi === ti) { setLocalErr("Cannot connect a member to itself"); return; }
        const duplicate = (editing.connections || []).some(
          c => c.conn_type !== "value" && c.from_member_idx === fi && c.from_var_name === fromVar && c.to_member_idx === ti && c.to_var_name === toVar
        );
        if (duplicate) { setLocalErr("This connection already exists"); return; }
        setLocalErr("");
        setEditing(prev => ({
          ...prev,
          connections: [...(prev.connections || []), { conn_type: "interconnection", from_member_idx: fi, from_var_name: fromVar, to_member_idx: ti, to_var_name: toVar }],
        }));
        setWire(w => ({ ...w, fromVar: "", toVar: "" }));
    } else {
        // value type — static or derived
        const ti = parseInt(toIdx);
        const duplicate = (editing.connections || []).some(
          c => c.conn_type === "value" && c.to_member_idx === ti && c.to_var_name === toVar
        );
        if (duplicate) { setLocalErr("A value is already assigned to that input"); return; }

        if (valueMode === "derived") {
          if (!column) return;
          setLocalErr("");
          setEditing(prev => ({
            ...prev,
            connections: [...(prev.connections || []), {
              conn_type: "value", from_member_idx: -1, from_var_name: "",
              to_member_idx: ti, to_var_name: toVar,
              value_mode: "derived", column, prefix: prefix.trim(), suffix: suffix.trim(),
            }],
          }));
          setWire(w => ({ ...w, toVar: "", column: "", prefix: "", suffix: "" }));
        } else {
          if (!staticValue.trim()) return;
          setLocalErr("");
          setEditing(prev => ({
            ...prev,
            connections: [...(prev.connections || []), { conn_type: "value", from_member_idx: -1, from_var_name: "", to_member_idx: ti, to_var_name: toVar, value_mode: "static", static_value: staticValue.trim() }],
          }));
          setWire(w => ({ ...w, toVar: "", staticValue: "" }));
        }
    }
  }

  function removeConnection(i) {
    setEditing(prev => ({ ...prev, connections: prev.connections.filter((_, j) => j !== i) }));
  }

  const cmTypeOptions = cmtProfiles.map(p => p.cmType);

  return (
    <div>
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Composite CM Types</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            Group multiple CM types into a single reusable entity. Each member is placed in its own hierarchy folder and can carry a naming prefix/suffix.
          </div>
        </div>

        {localErr && (
          <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: "var(--border-radius-md)",
              padding: "8px 12px", marginBottom: "1rem", fontSize: 13, color: "#991B1B" }}>
            {localErr}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 12, minHeight: "100vh" }}>
          {/* List panel */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)",
              display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "8px", borderBottom: "0.5px solid var(--color-border-tertiary)",
                background: "var(--color-background-secondary)", flexShrink: 0 }}>
              <Btn primary onClick={startNew} style={{ width: "100%", justifyContent: "center" }}>
                <i className="ti ti-plus" /> New Composite
              </Btn>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {composites.length === 0 ? (
                <div style={{ padding: "1rem", fontSize: 12, color: "var(--color-text-secondary)", textAlign: "center" }}>
                  No composites yet
                </div>
              ) : composites.map(c => (
                <div key={c.id} onClick={() => selectComposite(c.id)}
                  style={{ padding: "8px 10px", cursor: "pointer",
                    borderBottom: "0.5px solid var(--color-border-tertiary)",
                    background: selectedId === c.id ? "#EEEDFE" : "transparent",
                    display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontSize: 12, fontWeight: 500, fontFamily: "var(--font-mono)" }}>{c.name}</span>
                      {!!c.is_matrix && (
                        <span style={{ fontSize: 9, padding: "0 4px", borderRadius: 3,
                            background: "#DCFCE7", color: "#166534", fontWeight: 700, flexShrink: 0 }}>MTX</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>
                      {c.is_matrix ? "Matrix CM" : `${c.member_count} member${c.member_count !== 1 ? "s" : ""}`}
                    </div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); handleDelete(c.id); }}
                    style={{ border: "none", background: "transparent", cursor: "pointer",
                      padding: "2px 4px", color: "var(--color-text-secondary)", fontSize: 13, lineHeight: 1 }}>
                    <i className="ti ti-trash" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Editor panel */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)",
              padding: "1rem 1.25rem", overflowY: "auto", flex: 1 }}>
            {!editing ? (
              <div style={{ color: "var(--color-text-secondary)", fontSize: 13, paddingTop: "2rem", textAlign: "center" }}>
                Select a composite or create a new one
              </div>
            ) : (
              <>
                {/* Header fields */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: "1.25rem" }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
                        color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Name *</label>
                    <input value={editing.name} onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
                      placeholder="e.g. Composite_CM_AO"
                      style={{ width: "100%", padding: "6px 10px", border: "0.5px solid var(--color-border-secondary)",
                        borderRadius: "var(--border-radius-md)", fontSize: 13, boxSizing: "border-box",
                        background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                        fontFamily: "var(--font-mono)" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
                        color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Description</label>
                    <input value={editing.description} onChange={e => setEditing(p => ({ ...p, description: e.target.value }))}
                      placeholder="Optional description"
                      style={{ width: "100%", padding: "6px 10px", border: "0.5px solid var(--color-border-secondary)",
                        borderRadius: "var(--border-radius-md)", fontSize: 13, boxSizing: "border-box",
                        background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
                  </div>
                </div>

                {/* Members table */}
                <div style={{ marginBottom: "1rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <SLabel text="Members" />
                    <Btn onClick={addMember} style={{ fontSize: 11 }}>
                      <i className="ti ti-plus" /> Add member
                    </Btn>
                  </div>

                  {editing.members.length === 0 ? (
                    <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
                        padding: "1.5rem", textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
                      No members — click "Add member" to start
                    </div>
                  ) : (
                    <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
                      {/* Table header */}
                      <div style={{ display: "grid",
                          gridTemplateColumns: "28px 1fr 110px 95px 95px 96px 56px",
                          padding: "5px 8px", background: "var(--color-background-secondary)",
                          borderBottom: "0.5px solid var(--color-border-tertiary)", gap: 6 }}>
                        {["", "CM Type", "Folder", "Prefix", "Suffix", "Scope", ""].map((h, i) => (
                          <div key={i} style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                              letterSpacing: "0.04em", color: "var(--color-text-secondary)" }}>{h}</div>
                        ))}
                      </div>

                      {editing.members.map((m, idx) => (
                        <div key={idx} style={{ display: "grid",
                            gridTemplateColumns: "28px 1fr 110px 95px 95px 96px 56px",
                            padding: "6px 8px", gap: 6, alignItems: "center",
                            borderBottom: idx < editing.members.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none",
                            background: idx % 2 === 0 ? "transparent" : "var(--color-background-secondary)" }}>

                          {/* Reorder */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                            <button onClick={() => moveMember(idx, -1)} disabled={idx === 0}
                              style={{ border: "none", background: "transparent", cursor: idx === 0 ? "default" : "pointer",
                                color: "var(--color-text-secondary)", fontSize: 11, padding: "1px 2px", lineHeight: 1, opacity: idx === 0 ? 0.3 : 1 }}>
                              <i className="ti ti-chevron-up" />
                            </button>
                            <button onClick={() => moveMember(idx, 1)} disabled={idx === editing.members.length - 1}
                              style={{ border: "none", background: "transparent",
                                cursor: idx === editing.members.length - 1 ? "default" : "pointer",
                                color: "var(--color-text-secondary)", fontSize: 11, padding: "1px 2px", lineHeight: 1,
                                opacity: idx === editing.members.length - 1 ? 0.3 : 1 }}>
                              <i className="ti ti-chevron-down" />
                            </button>
                          </div>

                          {/* CM Type */}
                          <select value={m.cm_type_name} onChange={e => updateMember(idx, "cm_type_name", e.target.value)}
                            style={{ width: "100%", padding: "4px 6px", border: "0.5px solid var(--color-border-secondary)",
                              borderRadius: "var(--border-radius-md)", fontSize: 12,
                              background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                              fontFamily: "var(--font-mono)" }}>
                            <option value="">— select —</option>
                            {cmTypeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>

                          {/* Hierarchy Folder */}
                          <input value={m.hierarchy_folder} onChange={e => updateMember(idx, "hierarchy_folder", e.target.value)}
                            placeholder="CM"
                            style={{ width: "100%", padding: "4px 6px", border: "0.5px solid var(--color-border-secondary)",
                              borderRadius: "var(--border-radius-md)", fontSize: 12, boxSizing: "border-box",
                              background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />

                          {/* Prefix */}
                          <input value={m.name_prefix} onChange={e => updateMember(idx, "name_prefix", e.target.value)}
                            placeholder="e.g. NIF_"
                            style={{ width: "100%", padding: "4px 6px", border: "0.5px solid var(--color-border-secondary)",
                              borderRadius: "var(--border-radius-md)", fontSize: 12, boxSizing: "border-box",
                              background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                              fontFamily: "var(--font-mono)" }} />

                          {/* Suffix */}
                          <input value={m.name_suffix} onChange={e => updateMember(idx, "name_suffix", e.target.value)}
                            placeholder="e.g. _1"
                            style={{ width: "100%", padding: "4px 6px", border: "0.5px solid var(--color-border-secondary)",
                              borderRadius: "var(--border-radius-md)", fontSize: 12, boxSizing: "border-box",
                              background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                              fontFamily: "var(--font-mono)" }} />

                          {/* Scope — unit (per unit) vs project (one shared instance) */}
                          <select value={m.scope || "unit"} onChange={e => updateMember(idx, "scope", e.target.value)}
                            title="Unit: one instance per unit. Project: a single shared instance per User Project."
                            style={{ width: "100%", padding: "4px 6px", border: "0.5px solid var(--color-border-secondary)",
                              borderRadius: "var(--border-radius-md)", fontSize: 11, boxSizing: "border-box",
                              background: m.scope === "project" ? "#FEF3C7" : "var(--color-background-primary)",
                              color: "var(--color-text-primary)" }}>
                            <option value="unit">Unit</option>
                            <option value="project">Project</option>
                          </select>

                          {/* Remove */}
                          <button onClick={() => removeMember(idx)}
                            style={{ border: "none", background: "transparent", cursor: "pointer",
                              color: "#DC2626", fontSize: 14, padding: "2px 4px" }}>
                            <i className="ti ti-x" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Naming preview */}
                  {editing.members.length > 0 && editing.members.some(m => m.cm_type_name) && (
                    <div style={{ marginTop: 10, padding: "8px 12px",
                        background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)",
                        border: "0.5px solid var(--color-border-tertiary)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
                          color: "var(--color-text-secondary)", marginBottom: 6 }}>
                        Naming preview (base name = "TAG")
                      </div>
                      {editing.members.filter(m => m.cm_type_name).map((m, i) => {
                        const derivedName = `${m.name_prefix || ""}TAG${m.name_suffix || ""}`;
                        return (
                          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center",
                              fontSize: 12, marginBottom: 3, fontFamily: "var(--font-mono)" }}>
                            <span style={{ color: "var(--color-text-secondary)", minWidth: 130, overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.cm_type_name}</span>
                            <span style={{ color: "var(--color-text-secondary)" }}>→</span>
                            <span style={{ fontWeight: 500 }}>{derivedName}</span>
                            <span style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>
                              in <em>{m.hierarchy_folder || "(unit root — no subfolder)"}</em>
                              {m.scope === "project" && <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: 4,
                                  background: "#FEF3C7", color: "#92400E", fontSize: 10, fontWeight: 600,
                                  fontFamily: "var(--font-sans)" }}>project · shared</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Matrix toggle — shown after members are defined */}
                <div style={{ marginBottom: "1rem", display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", background: editing.is_matrix ? "#F0FDF4" : "var(--color-background-secondary)",
                    borderRadius: "var(--border-radius-md)", border: `0.5px solid ${editing.is_matrix ? "#86EFAC" : "var(--color-border-tertiary)"}` }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                    <input type="checkbox" checked={!!editing.is_matrix}
                      onChange={e => setEditing(p => ({ ...p, is_matrix: e.target.checked }))} />
                    <span style={{ fontWeight: 600 }}>Matrix CM</span>
                  </label>
                  <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                    {editing.is_matrix
                      ? "Matrix grid is active — configure modes and valve states below"
                      : "Enable to configure an IEMT_MTX mode × valve state grid for this composite"}
                  </span>
                </div>

                {/* ── Matrix editor ─────────────────────────────────────────── */}
                {editing.is_matrix && (() => {
                  const columns    = editing.matrixColumns || [];
                  const modes      = editing.matrixModes   || [];
                  const cellSx     = { padding: "2px 4px", border: "0.5px solid var(--color-border-secondary)",
                    borderRadius: "var(--border-radius-md)", fontSize: 11, boxSizing: "border-box",
                    background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: "100%" };

                  function addColumn() {
                    setEditing(p => ({ ...p, matrixColumns: [...(p.matrixColumns || []), ""] }));
                  }
                  function updateColumn(ci, val) {
                    setEditing(p => {
                      const matrixColumns = [...(p.matrixColumns || [])];
                      const oldName = matrixColumns[ci];
                      matrixColumns[ci] = val;
                      const matrixModes = (p.matrixModes || []).map(m => {
                        const cells = { ...m.cells };
                        if (oldName && cells[oldName] !== undefined) {
                          cells[val] = cells[oldName];
                          delete cells[oldName];
                        }
                        return { ...m, cells };
                      });
                      return { ...p, matrixColumns, matrixModes };
                    });
                  }
                  function removeColumn(ci) {
                    setEditing(p => {
                      const colName = (p.matrixColumns || [])[ci];
                      const matrixColumns = (p.matrixColumns || []).filter((_, i) => i !== ci);
                      const matrixModes = (p.matrixModes || []).map(m => {
                        const cells = { ...m.cells };
                        delete cells[colName];
                        return { ...m, cells };
                      });
                      return { ...p, matrixColumns, matrixModes };
                    });
                  }
                  function addMode() {
                    setEditing(p => {
                      const modes = p.matrixModes || [];
                      const maxNr = modes.reduce((mx, m) => Math.max(mx, m.mode_nr ?? 0), 0);
                      return { ...p, matrixModes: [...modes, { mode_nr: maxNr + 1, mode_name: "", cells: {} }] };
                    });
                  }
                  function removeMode(mi) {
                    setEditing(p => ({ ...p, matrixModes: (p.matrixModes || []).filter((_, i) => i !== mi) }));
                  }
                  function updateModeField(mi, key, val) {
                    setEditing(p => ({
                      ...p,
                      matrixModes: (p.matrixModes || []).map((m, i) =>
                        i === mi ? { ...m, [key]: key === "mode_nr" ? (parseInt(val) || 0) : val } : m
                      ),
                    }));
                  }
                  function setCell(mi, colName, rawVal) {
                    const intVal = parseInt(rawVal);
                    setEditing(p => ({
                      ...p,
                      matrixModes: (p.matrixModes || []).map((m, i) =>
                        i === mi ? { ...m, cells: { ...m.cells, [colName]: isNaN(intVal) ? 0 : intVal } } : m
                      ),
                    }));
                  }

                  // Shared styles for the header row background
                  const hdrBg = "var(--color-background-secondary)";
                  const borderH = "0.5px solid var(--color-border-tertiary)";

                  function exportCsv() {
                    const SEP = ",";
                    const esc = v => {
                      const s = String(v);
                      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
                    };
                    // "sep=," as first line tells Excel which delimiter to use regardless of locale.
                    // Mode headers formatted as "Nr. Name" — plain text, no colon, easy to read in Excel.
                    const hdr = [esc("CM \\ Mode"), ...modes.map(m => esc(`${m.mode_nr ?? m.mode_nr}. ${m.mode_name ?? ""}`))];
                    const dataRows = columns.map(colName => [
                      esc(colName),
                      ...modes.map(m => esc((m.cells || {})[colName] ?? 0)),
                    ]);
                    // UTF-8 BOM (﻿) makes Excel open without the encoding/import dialog
                    const csv = "﻿" + [`sep=${SEP}`, hdr, ...dataRows].map(r =>
                      Array.isArray(r) ? r.join(SEP) : r
                    ).join("\r\n");
                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = `${editing.name || "matrix"}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }

                  function importCsv(file) {
                    const reader = new FileReader();
                    reader.onload = e => {
                      // Strip BOM if present, normalise line endings
                      let text = e.target.result.replace(/^﻿/, "");
                      text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

                      // Auto-detect separator from the first line (handles locales that save with ;)
                      const firstLine = text.split("\n")[0] || "";
                      const SEP = firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";

                      const parseRow = line => {
                        const cells = []; let cur = ""; let inQ = false;
                        for (let i = 0; i < line.length; i++) {
                          const ch = line[i];
                          if (inQ) {
                            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                            else if (ch === '"') { inQ = false; }
                            else cur += ch;
                          } else {
                            if (ch === '"') { inQ = true; }
                            else if (ch === SEP) { cells.push(cur.trim()); cur = ""; }
                            else cur += ch;
                          }
                        }
                        cells.push(cur.trim());
                        return cells;
                      };

                      let lines = text.split("\n").filter(l => l.trim());
                      // Skip "sep=X" hint line if present
                      if (lines.length && /^sep=/i.test(lines[0])) lines = lines.slice(1);
                      if (lines.length < 2) return;

                      const headerCells = parseRow(lines[0]);
                      // headerCells[0] = corner cell (ignored). Rest = mode headers "Nr. Name"
                      // Accepts: "1. Auto", "1:Auto", "1 - Auto", or bare "Auto"
                      const newModes = headerCells.slice(1).map((h, i) => {
                        const m = h.match(/^(\d+)[.\-: ]+(.*)$/);
                        const nr = m ? (parseInt(m[1]) || i + 1) : i + 1;
                        const name = m ? m[2].trim() : h.trim();
                        return { mode_nr: nr, mode_name: name, cells: {} };
                      });

                      const newColumns = [];
                      for (let ri = 1; ri < lines.length; ri++) {
                        const cells = parseRow(lines[ri]);
                        const cmName = cells[0] || "";
                        if (!cmName) continue;
                        newColumns.push(cmName);
                        newModes.forEach((m, mi) => {
                          const raw = cells[mi + 1] ?? "";
                          const v = parseInt(raw);
                          m.cells[cmName] = isNaN(v) ? 0 : v;
                        });
                      }
                      setEditing(p => ({ ...p, matrixColumns: newColumns, matrixModes: newModes }));
                    };
                    reader.readAsText(file, "UTF-8");
                  }

                  return (
                    <div style={{ marginBottom: "1.25rem" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                        <SLabel text="Mode × CM Matrix" />
                        <div style={{ display: "flex", gap: 6 }}>
                          <Btn onClick={exportCsv} style={{ fontSize: 11 }}
                            title="Export matrix to CSV (open in Excel, edit, then re-import)">
                            <i className="ti ti-download" /> Export CSV
                          </Btn>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 4,
                              cursor: "pointer", fontSize: 11,
                              padding: "4px 10px", borderRadius: "var(--border-radius-md)",
                              border: "0.5px solid var(--color-border-secondary)",
                              background: "var(--color-background-primary)",
                              color: "var(--color-text-primary)", userSelect: "none" }}
                            title="Import a previously exported CSV (replaces current matrix)">
                            <i className="ti ti-upload" /> Import CSV
                            <input type="file" accept=".csv" style={{ display: "none" }}
                              onChange={e => { const f = e.target.files[0]; if (f) { importCsv(f); e.target.value = ""; } }} />
                          </label>
                        </div>
                      </div>

                      {columns.length === 0 && modes.length === 0 ? (
                        <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
                            padding: "1rem", textAlign: "center", fontSize: 12, color: "var(--color-text-secondary)", marginTop: 8 }}>
                          No CMs or modes yet — use the buttons inside the table to start
                        </div>
                      ) : null}

                      <div style={{ overflowX: "auto", marginTop: 8 }}>
                        <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                          <thead>
                            <tr style={{ background: hdrBg }}>

                              {/* ── Corner cell: diagonal split "Mode / CM" ── */}
                              <th style={{ position: "relative", width: 110, minWidth: 110,
                                  padding: 0, borderBottom: borderH, borderRight: borderH,
                                  background: hdrBg }}>
                                <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                                    pointerEvents: "none" }} preserveAspectRatio="none">
                                  <line x1="0" y1="0" x2="100%" y2="100%"
                                    stroke="var(--color-border-tertiary)" strokeWidth="1" />
                                </svg>
                                {/* "Mode" in upper-right — describes the column axis */}
                                <span style={{ position: "absolute", top: 5, right: 7,
                                    fontSize: 10, fontWeight: 600, color: "var(--color-text-secondary)",
                                    lineHeight: 1, userSelect: "none" }}>
                                  Mode
                                </span>
                                {/* "CM" in lower-left — describes the row axis */}
                                <span style={{ position: "absolute", bottom: 5, left: 7,
                                    fontSize: 10, fontWeight: 600, color: "var(--color-text-secondary)",
                                    lineHeight: 1, userSelect: "none" }}>
                                  CM
                                </span>
                                {/* Invisible spacer so the th has height */}
                                <div style={{ visibility: "hidden", padding: "14px 8px", fontSize: 10 }}>CM{"\n"}Mode</div>
                              </th>

                              {/* ── One <th> per mode: Nr input + Name input + X ── */}
                              {modes.map((mode, mi) => (
                                <th key={mi} style={{ padding: "5px 6px", borderBottom: borderH,
                                    borderRight: borderH, textAlign: "center", minWidth: 140,
                                    verticalAlign: "bottom", background: hdrBg }}>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "stretch" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                      <input type="number" value={mode.mode_nr ?? mi + 1} min={1}
                                        onChange={e => updateModeField(mi, "mode_nr", e.target.value)}
                                        style={{ ...cellSx, width: 42, textAlign: "center",
                                          fontFamily: "var(--font-mono)", fontWeight: 600 }} />
                                      {/* X: delete this mode column */}
                                      <button onClick={() => removeMode(mi)}
                                        style={{ border: "none", background: "transparent", cursor: "pointer",
                                          color: "#DC2626", fontSize: 13, padding: "0 2px", marginLeft: "auto" }}>
                                        <i className="ti ti-x" />
                                      </button>
                                    </div>
                                    <input value={mode.mode_name ?? ""} placeholder="e.g. Auto"
                                      onChange={e => updateModeField(mi, "mode_name", e.target.value)}
                                      style={{ ...cellSx, width: "100%" }} />
                                  </div>
                                </th>
                              ))}

                              {/* ── "+ Add mode" as the last header cell ── */}
                              <th style={{ padding: "6px 8px", borderBottom: borderH,
                                  verticalAlign: "middle", background: hdrBg, whiteSpace: "nowrap" }}>
                                <Btn onClick={addMode} style={{ fontSize: 11 }}>
                                  <i className="ti ti-plus" /> Add mode
                                </Btn>
                              </th>
                            </tr>
                          </thead>

                          <tbody>
                            {/* ── One row per CM ── */}
                            {columns.map((colName, ci) => (
                              <tr key={ci} style={{ borderBottom: borderH,
                                  background: ci % 2 === 0 ? "transparent" : hdrBg }}>

                                {/* X then editable CM name — delete is at the START for easy scanning */}
                                <td style={{ padding: "3px 6px", borderRight: borderH, whiteSpace: "nowrap" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                    <button onClick={() => removeColumn(ci)}
                                      style={{ border: "none", background: "transparent", cursor: "pointer",
                                        color: "#DC2626", fontSize: 13, padding: "0 2px", flexShrink: 0 }}>
                                      <i className="ti ti-x" />
                                    </button>
                                    <input value={colName} onChange={e => updateColumn(ci, e.target.value)}
                                      placeholder={`RCM${String(ci + 1).padStart(2, "0")}`}
                                      style={{ ...cellSx, width: 90, fontFamily: "var(--font-mono)", fontWeight: 600 }} />
                                  </div>
                                </td>

                                {/* ── One dropdown cell per mode ── */}
                                {modes.map((mode, mi) => {
                                  const currentVal = (mode.cells || {})[colName] ?? 0;
                                  const knownOption = valveCommands.find(o => o.value === currentVal);
                                  return (
                                    <td key={mi} style={{ padding: "3px 6px", borderRight: borderH }}>
                                      <select
                                        value={knownOption ? currentVal : "__other__"}
                                        onChange={e => {
                                          if (e.target.value !== "__other__") setCell(mi, colName, e.target.value);
                                        }}
                                        style={{ ...cellSx, marginBottom: knownOption ? 0 : 3 }}>
                                        {valveCommands.map(o => (
                                          <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                        <option value="__other__">Other…</option>
                                      </select>
                                      {!knownOption && (
                                        <input type="number" value={currentVal} min={0}
                                          onChange={e => setCell(mi, colName, e.target.value)}
                                          placeholder="code"
                                          style={{ ...cellSx, fontFamily: "var(--font-mono)", marginTop: 2 }} />
                                      )}
                                    </td>
                                  );
                                })}

                                {/* Empty cell under "+ Add mode" column */}
                                <td />
                              </tr>
                            ))}

                            {/* ── "+ Add CM" as the last body row, in the label column ── */}
                            <tr>
                              <td style={{ padding: "5px 6px", borderRight: borderH }} colSpan={1}>
                                <Btn onClick={addColumn} style={{ fontSize: 11 }}>
                                  <i className="ti ti-plus" /> Add CM
                                </Btn>
                              </td>
                              {/* Span remaining mode cells + the add-mode column */}
                              <td colSpan={modes.length + 1} />
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}

                {/* ── Connections (Interconnection + Value + IO) ────────────── */}
                {!editing.is_matrix && editing.members.length >= 1 && (() => {
                  const namedMembers = editing.members.filter(m => m.cm_type_name);
                  if (namedMembers.length < 1) return null;

                  const memberVars  = editing.members.map(m => validVarsCache[m.cm_type_name] || { inputs: [], outputs: [] });
                  const hasAnyValid = memberVars.some(mv => mv.inputs.length || mv.outputs.length);

                  const isInterconn = wire.type === "interconnection";
                  const isValue     = wire.type === "value";
                  const isIo        = wire.type === "io";

                  const fromMember  = isInterconn && wire.fromIdx !== "" ? editing.members[parseInt(wire.fromIdx)] : null;
                  const fromOutputs = fromMember ? (validVarsCache[fromMember.cm_type_name]?.outputs || []) : [];
                  const toMember    = wire.toIdx !== "" ? editing.members[parseInt(wire.toIdx)] : null;
                  const toInputs    = toMember ? (validVarsCache[toMember.cm_type_name]?.inputs || []) : [];

                  const conns = editing.connections || [];

                  // ── IO connection rules (persisted per lib_cm_type via API) ──
                  const ioRules = editing.members.flatMap((m, mIdx) => {
                    if (!m.cm_type_name) return [];
                    const cache = ioRulesCache[m.cm_type_name];
                    if (!cache) return [];
                    return (cache.rules || []).map(r => ({ ...r, memberIdx: mIdx, member: m }));
                  });

                  // Input and output parameters for the selected member (block is derived from the parameter)
                  // Only show valid parameters (is_valid = 1)
                  function ioParamsForMember(cmTypeName) {
                    const cache = ioRulesCache[cmTypeName];
                    if (!cache) return [];
                    return (cache.vars || []).filter(v => v.is_valid);
                  }
                  const ioMember   = ioWire.memberIdx !== "" ? editing.members[parseInt(ioWire.memberIdx)] : null;
                  const ioParams   = ioMember ? ioParamsForMember(ioMember.cm_type_name) : [];
                  const ioSelParam = ioWire.paramKey
                    ? ioParams.find(v => `${v.block_name}>>${v.name}` === ioWire.paramKey)
                    : null;
                  const ioDtype    = ioSelParam?.dtype || "";

                  const canAddIo = ioWire.memberIdx !== "" && !!ioSelParam;

                  function handleAddIoRule() {
                    if (!canAddIo) return;
                    setIoErr("");
                    // Add to connections array like Interconnection/Value
                    setEditing(prev => ({
                      ...prev,
                      connections: [...(prev.connections || []), {
                        conn_type: 'io_connection',
                        to_member_idx: parseInt(ioWire.memberIdx),
                        to_var_name: ioSelParam.name,        // parameter name (pin)
                        block_name: ioSelParam.block_name,   // block name (derived from param)
                        prefix: ioWire.prefix,
                        suffix: ioWire.suffix,
                        dtype: ioDtype,                      // data type (derived from param)
                        required: ioWire.required,
                      }],
                    }));
                    setIoWire(w => ({ ...w, paramKey: "", suffix: "", prefix: "" }));
                  }

                  function handleDeleteIoRule(index) {
                    setEditing(prev => ({
                      ...prev,
                      connections: (prev.connections || []).filter((_, i) => i !== index),
                    }));
                  }

                  const isDerived = isValue && wire.valueMode === "derived";

                  const canAdd = isInterconn
                    ? wire.fromIdx !== "" && !!wire.fromVar && wire.toIdx !== "" && !!wire.toVar
                    : isValue
                      ? (isDerived
                          ? wire.toIdx !== "" && !!wire.toVar && !!wire.column
                          : wire.toIdx !== "" && !!wire.toVar && !!wire.staticValue.trim())
                      : false;

                  // Badge helpers
                  const TagOUT = () => (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: "#DCFCE7", color: "#166534", fontFamily: "var(--font-mono)", flexShrink: 0 }}>OUT</span>
                  );
                  const TagIN = () => (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: "#DBEAFE", color: "#1D4ED8", fontFamily: "var(--font-mono)", flexShrink: 0 }}>IN</span>
                  );
                  const TagVAL = () => (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: "#FEF9C3", color: "#854D0E", fontFamily: "var(--font-mono)", flexShrink: 0 }}>VAL</span>
                  );
                  const TagIO = () => (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: "#CCFBF1", color: "#0F766E", fontFamily: "var(--font-mono)", flexShrink: 0 }}>IO</span>
                  );

                  const selStyle = (borderColor) => ({
                    width: "100%", padding: "5px 6px", border: `0.5px solid ${borderColor}`,
                    borderRadius: "var(--border-radius-md)", fontSize: 11, boxSizing: "border-box",
                    background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                    fontFamily: "var(--font-mono)",
                  });

                  const hasAnyConn = conns.length > 0 || ioRules.length > 0;

                  return (
                    <div style={{ marginTop: "1.5rem" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <SLabel text="Connections" />
                        {!hasAnyValid && !isIo && (
                          <span style={{ fontSize: 11, color: "#B45309", background: "#FEF3C7",
                              padding: "2px 8px", borderRadius: 4, border: "0.5px solid #FDE68A" }}>
                            Mark input/output variables as "Valid" in Type Configuration first
                          </span>
                        )}
                      </div>

                      {ioErr && (
                        <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: "var(--border-radius-md)",
                            padding: "5px 10px", marginBottom: 8, fontSize: 12, color: "#991B1B" }}>
                          {ioErr}
                        </div>
                      )}

                      {/* Existing connections list (interconnection + value + IO) */}
                      {hasAnyConn && (
                        <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                          {conns.map((c, ci) => {
                            // IO Connection
                            if (c.conn_type === 'io_connection') {
                              const toM = editing.members[c.to_member_idx];
                              if (!toM) return null;
                              return (
                                <div key={ci} style={{ display: "flex", alignItems: "center", gap: 6,
                                    padding: "5px 10px", background: "#F0FDFA",
                                    border: "0.5px solid #99F6E4", borderRadius: "var(--border-radius-md)" }}>
                                  <TagIO />
                                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", flexShrink: 0 }}>
                                    [{c.to_member_idx}] {toM.cm_type_name}
                                  </span>
                                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
                                    {c.block_name}·{c.to_var_name}
                                  </span>
                                  <i className="ti ti-arrow-right" style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
                                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, color: "#0F766E" }}>
                                    {c.prefix || ""}<span style={{ color: "#9CA3AF" }}>&lt;tag&gt;</span>{c.suffix || ""}
                                  </span>
                                  {c.dtype && (
                                    <span style={{ padding: "0 5px", borderRadius: 3, fontSize: 10, fontWeight: 700,
                                        background: "#E0E7FF", color: "#3730A3", fontFamily: "var(--font-mono)" }}>
                                      {c.dtype}
                                    </span>
                                  )}
                                  {!c.required && (
                                    <span style={{ padding: "0 5px", borderRadius: 3, fontSize: 10,
                                        background: "#F3F4F6", color: "#6B7280" }}>optional</span>
                                  )}
                                  <div style={{ flex: 1 }} />
                                  <button onClick={() => handleDeleteIoRule(ci)}
                                    style={{ border: "none", background: "transparent", cursor: "pointer",
                                      color: "#DC2626", fontSize: 14, padding: "2px 4px" }}>
                                    <i className="ti ti-x" />
                                  </button>
                                </div>
                              );
                            }

                            // Value connection
                            const toM = editing.members[c.to_member_idx];
                            if (!toM) return null;
                            const toLabel = `${toM.cm_type_name} · ${c.to_var_name}`;

                            if (c.conn_type === "value") {
                              const derived = c.value_mode === "derived";
                              return (
                                <div key={ci} style={{ display: "flex", alignItems: "center", gap: 6,
                                    padding: "5px 10px", background: "#FEFCE8",
                                    border: "0.5px solid #FDE68A", borderRadius: "var(--border-radius-md)" }}>
                                  <TagVAL />
                                  {derived ? (
                                    <>
                                      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, color: "#854D0E" }}>
                                        {c.prefix || ""}<span style={{ color: "#9CA3AF" }}>&lt;tag&gt;</span>{c.suffix || ""}
                                      </span>
                                      <span style={{ padding: "0 5px", borderRadius: 3, fontSize: 10, fontWeight: 700,
                                          background: "#E0E7FF", color: "#3730A3", fontFamily: "var(--font-mono)" }}>
                                        {c.column}
                                      </span>
                                    </>
                                  ) : (
                                    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, color: "#854D0E" }}>
                                      {c.static_value}
                                    </span>
                                  )}
                                  <i className="ti ti-arrow-right" style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
                                  <TagIN />
                                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>{toLabel}</span>
                                  <div style={{ flex: 1 }} />
                                  <button onClick={() => removeConnection(ci)}
                                    style={{ border: "none", background: "transparent", cursor: "pointer",
                                      color: "#DC2626", fontSize: 14, padding: "2px 4px" }}>
                                    <i className="ti ti-x" />
                                  </button>
                                </div>
                              );
                            }

                            // Interconnection
                            const fromM = editing.members[c.from_member_idx];
                            if (!fromM) return null;
                            const fromLabel = `${fromM.cm_type_name} · ${c.from_var_name}`;
                            return (
                              <div key={ci} style={{ display: "flex", alignItems: "center", gap: 6,
                                  padding: "5px 10px", background: "var(--color-background-secondary)",
                                  border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)" }}>
                                <TagOUT />
                                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>{fromLabel}</span>
                                <i className="ti ti-arrow-right" style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
                                <TagIN />
                                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>{toLabel}</span>
                                <div style={{ flex: 1 }} />
                                <button onClick={() => removeConnection(ci)}
                                  style={{ border: "none", background: "transparent", cursor: "pointer",
                                    color: "#DC2626", fontSize: 14, padding: "2px 4px" }}>
                                  <i className="ti ti-x" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Add-connection row */}
                      <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)",
                          padding: "10px 12px", background: "var(--color-background-secondary)" }}>

                        {/* Type toggle */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase",
                              letterSpacing: "0.04em", color: "var(--color-text-secondary)",
                              alignSelf: "center", marginRight: 4 }}>Type:</div>
                          {[
                            { val: "interconnection", icon: "ti-arrows-exchange", label: "Interconnection", desc: "Output → Input", on: "#6366F1", bg: "#EEF2FF", fg: "#4338CA" },
                            { val: "value",           icon: "ti-letter-v",        label: "Value",           desc: "Static → Input", on: "#D97706", bg: "#FEF3C7", fg: "#92400E" },
                            { val: "io",              icon: "ti-plug-connected",   label: "IO Connection",   desc: "Signal → Pin",   on: "#0D9488", bg: "#CCFBF1", fg: "#0F766E" },
                          ].map(opt => (
                            <button key={opt.val} onClick={() => setWire(w => ({ ...w, type: opt.val, fromIdx: "", fromVar: "", toIdx: "", toVar: "", staticValue: "", valueMode: "static", column: "", prefix: "", suffix: "" }))}
                              style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px",
                                border: `1.5px solid ${wire.type === opt.val ? opt.on : "var(--color-border-secondary)"}`,
                                borderRadius: "var(--border-radius-md)", cursor: "pointer", fontSize: 11, fontWeight: 600,
                                background: wire.type === opt.val ? opt.bg : "var(--color-background-primary)",
                                color: wire.type === opt.val ? opt.fg : "var(--color-text-secondary)",
                              }}>
                              <i className={`ti ${opt.icon}`} />
                              {opt.label}
                              <span style={{ fontWeight: 400, opacity: 0.75, fontSize: 10 }}>({opt.desc})</span>
                            </button>
                          ))}
                        </div>

                        {/* IO Connection fields */}
                        {isIo ? (
                          <>
                            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                              {/* Member */}
                              <div style={{ flex: "0 0 180px" }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: "0.04em", color: "#0F766E", marginBottom: 3 }}>Member</div>
                                <select value={ioWire.memberIdx}
                                  onChange={e => setIoWire(w => ({ ...w, memberIdx: e.target.value, paramKey: "" }))}
                                  style={selStyle("#5EEAD4")}>
                                  <option value="">— member —</option>
                                  {editing.members.map((m, mi) => m.cm_type_name ? (
                                    <option key={mi} value={mi}>[{mi}] {m.cm_type_name}</option>
                                  ) : null)}
                                </select>
                              </div>

                              {/* Parameter (block derived automatically) */}
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: "0.04em", color: "#0F766E", marginBottom: 3 }}>Parameter</div>
                                <select value={ioWire.paramKey}
                                  onChange={e => setIoWire(w => ({ ...w, paramKey: e.target.value }))}
                                  disabled={!ioParams.length}
                                  style={selStyle("#5EEAD4")}>
                                  <option value="">— parameter (input/output) —</option>
                                  {ioParams.map(v => {
                                    const dir = /output/i.test(v.dir || "") ? "OUT" : /input/i.test(v.dir || "") ? "IN" : "";
                                    return (
                                      <option key={`${v.block_name}>>${v.name}`} value={`${v.block_name}>>${v.name}`}>
                                        {v.block_name}·{v.name}{v.dtype ? ` (${v.dtype})` : ""}{dir ? ` [${dir}]` : ""}
                                      </option>
                                    );
                                  })}
                                </select>
                              </div>

                              {/* Data type — derived (read-only) */}
                              <div style={{ flex: "0 0 80px" }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: "0.04em", color: "var(--color-text-secondary)", marginBottom: 3 }}>Data type</div>
                                <div style={{ padding: "5px 6px", border: "0.5px solid var(--color-border-tertiary)",
                                    borderRadius: "var(--border-radius-md)", fontSize: 11, fontFamily: "var(--font-mono)",
                                    background: "var(--color-background-secondary)",
                                    color: ioDtype ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                                    textAlign: "center", boxSizing: "border-box" }}>
                                  {ioDtype || "—"}
                                </div>
                              </div>

                              {/* Prefix */}
                              <div style={{ flex: "0 0 90px" }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: "0.04em", color: "var(--color-text-secondary)", marginBottom: 3 }}>Prefix</div>
                                <input value={ioWire.prefix}
                                  onChange={e => setIoWire(w => ({ ...w, prefix: e.target.value }))}
                                  placeholder="" style={selStyle("var(--color-border-secondary)")} />
                              </div>

                              {/* Suffix */}
                              <div style={{ flex: "0 0 90px" }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: "0.04em", color: "var(--color-text-secondary)", marginBottom: 3 }}>Suffix</div>
                                <input value={ioWire.suffix}
                                  onChange={e => setIoWire(w => ({ ...w, suffix: e.target.value }))}
                                  placeholder="_GSH" style={selStyle("var(--color-border-secondary)")} />
                              </div>

                              {/* Required */}
                              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11,
                                  paddingBottom: 6, flexShrink: 0, cursor: "pointer" }}
                                title="If unmatched by hardware, this pin's block is omitted from CM export">
                                <input type="checkbox" checked={ioWire.required}
                                  onChange={e => setIoWire(w => ({ ...w, required: e.target.checked }))} />
                                Req
                              </label>

                              <Btn primary onClick={handleAddIoRule} disabled={!canAddIo}
                                style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                                <i className="ti ti-plus" /> Add
                              </Btn>
                            </div>

                            {/* Signal-name preview */}
                            {ioSelParam && (
                              <div style={{ marginTop: 8, fontSize: 11, fontFamily: "var(--font-mono)",
                                  color: "var(--color-text-secondary)" }}>
                                Signal name: <span style={{ fontWeight: 600, color: "#0F766E" }}>
                                  {ioWire.prefix || ""}<span style={{ color: "#9CA3AF" }}>XV001</span>{ioWire.suffix || ""}
                                </span> → {ioSelParam.block_name}·{ioSelParam.name}
                              </div>
                            )}
                          </>
                        ) : (!hasAnyValid) ? (
                          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "4px 2px" }}>
                            No valid variables marked yet. Go to Library → Type Configuration → Inputs or Outputs tab
                            and click the plug icon to expose variables for wiring.
                          </div>
                        ) : (
                          /* Interconnection / Value fields row */
                          <div>
                            {/* Static / Derived slider — only for Value */}
                            {isValue && (
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: "0.04em", color: "var(--color-text-secondary)" }}>Value source:</div>
                                <div style={{ display: "flex", border: "1px solid var(--color-border-secondary)",
                                    borderRadius: 999, padding: 2, background: "var(--color-background-primary)" }}>
                                  {[
                                    { val: "static",  label: "Static" },
                                    { val: "derived", label: "Derived from IO list" },
                                  ].map(opt => (
                                    <button key={opt.val}
                                      onClick={() => setWire(w => ({ ...w, valueMode: opt.val }))}
                                      style={{ padding: "3px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                                        fontSize: 11, fontWeight: 600,
                                        background: wire.valueMode === opt.val ? "#D97706" : "transparent",
                                        color: wire.valueMode === opt.val ? "#fff" : "var(--color-text-secondary)" }}>
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>

                            {/* Source — only for Interconnection */}
                            {isInterconn && (
                              <>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                      letterSpacing: "0.04em", color: "#166534", marginBottom: 3 }}>Output from member</div>
                                  <div style={{ display: "flex", gap: 4 }}>
                                    <select value={wire.fromIdx}
                                      onChange={e => setWire(w => ({ ...w, fromIdx: e.target.value, fromVar: "" }))}
                                      style={{ ...selStyle("#86EFAC"), flex: "0 0 52%" }}>
                                      <option value="">— member —</option>
                                      {editing.members.map((m, mi) => !m.cm_type_name ? null : (
                                        <option key={mi} value={mi}
                                          disabled={(validVarsCache[m.cm_type_name]?.outputs || []).length === 0}>
                                          [{mi}] {m.cm_type_name}{(validVarsCache[m.cm_type_name]?.outputs || []).length === 0 ? " (no valid outputs)" : ""}
                                        </option>
                                      ))}
                                    </select>
                                    <select value={wire.fromVar}
                                      onChange={e => setWire(w => ({ ...w, fromVar: e.target.value }))}
                                      disabled={!fromOutputs.length}
                                      style={{ ...selStyle("#86EFAC"), flex: 1 }}>
                                      <option value="">— output var —</option>
                                      {fromOutputs.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                                    </select>
                                  </div>
                                </div>
                                <div style={{ fontSize: 18, color: "var(--color-text-secondary)", paddingBottom: 4, flexShrink: 0 }}>→</div>
                              </>
                            )}

                            {/* Static value — only for Value + static mode */}
                            {isValue && !isDerived && (
                              <>
                                <div style={{ flex: "0 0 160px" }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                      letterSpacing: "0.04em", color: "#854D0E", marginBottom: 3 }}>Static value</div>
                                  <input value={wire.staticValue}
                                    onChange={e => setWire(w => ({ ...w, staticValue: e.target.value }))}
                                    placeholder='e.g. 1, true, "text"'
                                    style={{ width: "100%", padding: "5px 6px", border: "0.5px solid #FCD34D",
                                      borderRadius: "var(--border-radius-md)", fontSize: 11, boxSizing: "border-box",
                                      background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                                      fontFamily: "var(--font-mono)" }} />
                                </div>
                                <div style={{ fontSize: 18, color: "var(--color-text-secondary)", paddingBottom: 4, flexShrink: 0 }}>→</div>
                              </>
                            )}

                            {/* Derived fields — only for Value + derived mode */}
                            {isDerived && (
                              <>
                                <div style={{ flex: "0 0 90px" }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                      letterSpacing: "0.04em", color: "#854D0E", marginBottom: 3 }}>Prefix</div>
                                  <input value={wire.prefix}
                                    onChange={e => setWire(w => ({ ...w, prefix: e.target.value }))}
                                    placeholder="" style={selStyle("#FCD34D")} />
                                </div>
                                <div style={{ flex: "0 0 90px" }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                      letterSpacing: "0.04em", color: "#854D0E", marginBottom: 3 }}>Suffix</div>
                                  <input value={wire.suffix}
                                    onChange={e => setWire(w => ({ ...w, suffix: e.target.value }))}
                                    placeholder="_PV" style={selStyle("#FCD34D")} />
                                </div>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                      letterSpacing: "0.04em", color: "#854D0E", marginBottom: 3 }}>Column</div>
                                  <select value={wire.column}
                                    onChange={e => setWire(w => ({ ...w, column: e.target.value }))}
                                    disabled={!ioColumns.length}
                                    style={selStyle("#FCD34D")}>
                                    <option value="">— IO list column —</option>
                                    {ioColumns.map(h => <option key={h} value={h}>{h}</option>)}
                                  </select>
                                </div>
                                <div style={{ fontSize: 18, color: "var(--color-text-secondary)", paddingBottom: 4, flexShrink: 0 }}>→</div>
                              </>
                            )}

                            {/* Destination — always shown for interconnection/value */}
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                                  letterSpacing: "0.04em", color: "#1D4ED8", marginBottom: 3 }}>Input to member</div>
                              <div style={{ display: "flex", gap: 4 }}>
                                <select value={wire.toIdx}
                                  onChange={e => setWire(w => ({ ...w, toIdx: e.target.value, toVar: "" }))}
                                  style={{ ...selStyle("#93C5FD"), flex: "0 0 52%" }}>
                                  <option value="">— member —</option>
                                  {editing.members.map((m, mi) => !m.cm_type_name ? null : (
                                    <option key={mi} value={mi}
                                      disabled={(validVarsCache[m.cm_type_name]?.inputs || []).length === 0}>
                                      [{mi}] {m.cm_type_name}{(validVarsCache[m.cm_type_name]?.inputs || []).length === 0 ? " (no valid inputs)" : ""}
                                    </option>
                                  ))}
                                </select>
                                <select value={wire.toVar}
                                  onChange={e => setWire(w => ({ ...w, toVar: e.target.value }))}
                                  disabled={!toInputs.length}
                                  style={{ ...selStyle("#93C5FD"), flex: 1 }}>
                                  <option value="">— input var —</option>
                                  {toInputs.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                                </select>
                              </div>
                            </div>

                            <Btn primary onClick={addConnection} disabled={!canAdd}
                              style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                              <i className="ti ti-plus" /> Add
                            </Btn>
                          </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Save button */}
                <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 12 }}>
                  <Btn primary onClick={handleSave} disabled={busy}>
                    {busy ? "Saving…" : selectedId ? "Save changes" : "Create composite"}
                  </Btn>
                </div>
              </>
            )}
          </div>
        </div>
    </div>
  );
}

// ── Step 4: Instances ────────────────────────────────────────────────────────
// ── Hierarchy helpers ────────────────────────────────────────────────────────
// Sort folders so every row appears after its parent (single-pass insert on the backend).
function topoSortHierarchy(folders) {
  const byParent = {};
  for (const f of folders) (byParent[f.parentId ?? "_root"] ||= []).push(f);
  for (const k of Object.keys(byParent)) byParent[k].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const out = [];
  const walk = (pid) => {
    for (const f of byParent[pid ?? "_root"] || []) { out.push(f); walk(f.id); }
  };
  walk(null);
  return out;
}

// All folders (any level) with breadcrumb labels — for the hierarchy folder picker.
function allFolderOptions(folders) {
  if (!folders?.length) return [];
  const byId = Object.fromEntries(folders.map(f => [f.id, f]));
  const pathOf = (f) => {
    const parts = [];
    let cur = f;
    while (cur) { parts.unshift(cur.name || "(unnamed)"); cur = cur.parentId ? byId[cur.parentId] : null; }
    return parts.join(" / ");
  };
  return topoSortHierarchy(folders).map(f => ({ id: f.id, label: pathOf(f) }));
}

// Leaf folders (no children) returned with breadcrumb labels for selectors.
function leafFolders(folders) {
  if (!folders?.length) return [];
  const byId       = Object.fromEntries(folders.map(f => [f.id, f]));
  const hasChild   = new Set(folders.filter(f => f.parentId).map(f => f.parentId));
  const pathOf = (f) => {
    const parts = [];
    let cur = f;
    while (cur) { parts.unshift(cur.name || "(unnamed)"); cur = cur.parentId ? byId[cur.parentId] : null; }
    return parts.join(" / ");
  };
  return folders
    .filter(f => !hasChild.has(f.id))
    .map(f => ({ id: f.id, label: pathOf(f) }));
}

// ── Step 3: Hierarchy editor ─────────────────────────────────────────────────
function StepHierarchy({ hierarchy, setHierarchy, instances, setInstances, savedProjectName }) {
  function addFolder(parentId = null) {
    const sibs = hierarchy.filter(f => (f.parentId ?? null) === parentId);
    setHierarchy([...hierarchy, {
        id:        newFolderClientId(),
        parentId,
        name:      parentId ? "" : "ProcessCell",
        s88Type:   parentId ? "" : "ProcessCell",
        sortOrder: sibs.length,
    }]);
  }
  function updateFolder(id, key, value) {
    setHierarchy(hierarchy.map(f => f.id === id ? { ...f, [key]: value } : f));
  }
  function deleteFolder(id) {
    // Collect the subtree.
    const drop = new Set([id]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const f of hierarchy) {
          if (f.parentId && drop.has(f.parentId) && !drop.has(f.id)) { drop.add(f.id); changed = true; }
        }
    }
    const affected = instances.filter(i => drop.has(i.folderId));
    if (affected.length && !window.confirm(`${affected.length} instance(s) are assigned to this folder or its descendants. Removing will clear their folder assignment. Continue?`)) return;
    setHierarchy(hierarchy.filter(f => !drop.has(f.id)));
    setInstances(instances.map(i => drop.has(i.folderId) ? { ...i, folderId: "" } : i));
  }

  const roots = hierarchy.filter(f => f.parentId == null);

  return (
    <div>
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
            Plant hierarchy {savedProjectName && <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>· {savedProjectName}</span>}
          </div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            Build the ISA S88 tree. CM instances are assigned to leaf folders on the next step.
            Leave empty to fall back to a single auto-created Process cell.
          </div>
        </div>

        {hierarchy.length === 0 ? (
          <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
              padding: "2rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13, marginBottom: "1rem" }}>
            No hierarchy yet — leave empty for default, or click "Add root folder" below
          </div>
        ) : (
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)",
              padding: "0.5rem 0.75rem", marginBottom: "1rem" }}>
            {roots.map(r => (
              <FolderRow key={r.id} folder={r} all={hierarchy} depth={0}
                onAdd={addFolder} onUpdate={updateFolder} onDelete={deleteFolder} />
            ))}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <Btn onClick={() => addFolder(null)}><i className="ti ti-plus" /> Add root folder</Btn>
        </div>
    </div>
  );
}

function FolderRow({ folder, all, depth, onAdd, onUpdate, onDelete }) {
  const children = all.filter(f => f.parentId === folder.id);
  return (
    <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0",
            paddingLeft: depth * 18 }}>
          <i className="ti ti-folder" style={{ fontSize: 14, color: "var(--color-text-secondary)" }} />
          <input value={folder.name} onChange={e => onUpdate(folder.id, "name", e.target.value)}
            placeholder="folder name"
            style={{ flex: 1, padding: "3px 8px", border: "0.5px solid var(--color-border-secondary)",
              borderRadius: "var(--border-radius-md)", fontSize: 12, fontFamily: "var(--font-mono)",
              background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
          <select value={folder.s88Type || ""} onChange={e => onUpdate(folder.id, "s88Type", e.target.value)}
            style={{ width: 110, padding: "3px 6px", border: "0.5px solid var(--color-border-secondary)",
              borderRadius: "var(--border-radius-md)", fontSize: 12,
              background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
            {S88_TYPES.map(t => <option key={t} value={t}>{t || "— plain —"}</option>)}
          </select>
          <button onClick={() => onAdd(folder.id)} title="Add subfolder"
            style={{ background: "transparent", border: "0.5px solid var(--color-border-secondary)", cursor: "pointer",
              color: "var(--color-text-secondary)", fontSize: 12, padding: "2px 6px", borderRadius: "var(--border-radius-md)" }}>
            <i className="ti ti-plus" />
          </button>
          <button onClick={() => onDelete(folder.id)} title="Delete folder"
            style={{ background: "transparent", border: "none", cursor: "pointer",
              color: "var(--color-text-secondary)", fontSize: 14, padding: 0 }}>
            <i className="ti ti-trash" />
          </button>
        </div>
        {children.map(c => (
          <FolderRow key={c.id} folder={c} all={all} depth={depth + 1}
            onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />
        ))}
    </div>
  );
}

// ── Instance row (shared across tabs) ────────────────────────────────────────
// ── Composite instance creation modal ────────────────────────────────────────
function CompositeInstanceModal({ compositeCmTypes, folderOptions, userProjects, onConfirm, onCancel }) {
  const [compositeId, setCompositeId] = useState(compositeCmTypes[0]?.id?.toString() || "");
  const [baseName,    setBaseName]    = useState("");
  const [rootFolderId, setRootFolderId] = useState(folderOptions[0]?.id || "");
  const [userProject, setUserProject] = useState(userProjects[0] || "");
  const [compDetail,  setCompDetail]  = useState(null); // full detail with members[]
  const [memberFolders, setMemberFolders] = useState({}); // memberIdx -> folderId

  const inputSx = { padding: "4px 8px", border: "0.5px solid var(--color-border-secondary)",
    borderRadius: "var(--border-radius-md)", fontSize: 12, fontFamily: "var(--font-mono)",
    background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: "100%" };

  // Load full detail (with members) whenever the selected composite changes
  useEffect(() => {
    if (!compositeId) { setCompDetail(null); setMemberFolders({}); return; }
    getCompositeCmType(parseInt(compositeId)).then(d => {
      setCompDetail(d);
      // Initialize each member with the root folder
      const folders = {};
      (d.members || []).forEach((_, i) => {
        folders[i] = rootFolderId;
      });
      setMemberFolders(folders);
    }).catch(() => { setCompDetail(null); setMemberFolders({}); });
  }, [compositeId]);

  // Update member folders when root folder changes
  useEffect(() => {
    setMemberFolders(prev => {
      const updated = { ...prev };
      (compDetail?.members || []).forEach((_, i) => {
        updated[i] = rootFolderId;
      });
      return updated;
    });
  }, [rootFolderId, compDetail?.members.length]);

  const handleMemberFolderChange = (memberIdx, folderId) => {
    setMemberFolders(prev => ({ ...prev, [memberIdx]: folderId }));
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 999 }}>
        <div style={{ background: "var(--color-background-primary)", borderRadius: "var(--border-radius-lg)",
            padding: 20, width: 560, display: "flex", flexDirection: "column", gap: 12,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)", maxHeight: "90vh", overflowY: "auto" }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Add Composite CM Instances</div>

          <div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Composite Type</div>
            <select value={compositeId} onChange={e => setCompositeId(e.target.value)} style={inputSx}>
              {compositeCmTypes.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>
              Base name (instrument / tag name)
            </div>
            <input value={baseName} onChange={e => setBaseName(e.target.value)}
              placeholder="e.g. TAG_001" autoFocus style={inputSx} />
          </div>

          <div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>User Project</div>
            <select value={userProject} onChange={e => setUserProject(e.target.value)} style={inputSx}>
              <option value="">— none —</option>
              {userProjects.map(up => <option key={up} value={up}>{up}</option>)}
            </select>
          </div>

          {/* Member folder assignments */}
          {baseName && compDetail && (compDetail.members || []).length > 0 && (
            <div style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)",
                padding: "12px 14px", fontSize: 11 }}>
              <div style={{ fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 10,
                  textTransform: "uppercase", letterSpacing: "0.04em" }}>Member Placement</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(compDetail.members || []).map((m, i) => {
                  const name = m.is_primary
                    ? baseName
                    : `${m.name_prefix || ""}${baseName}${m.name_suffix || ""}`;
                  return (
                    <div key={i}>
                      <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 4, fontFamily: "var(--font-mono)" }}>
                        {m.cm_type_name || "—"}
                        <span style={{ marginLeft: 6, color: "var(--color-text-secondary)", fontWeight: 400 }}>
                          {name}
                          {m.is_primary && <span style={{ marginLeft: 4 }}>(primary)</span>}
                        </span>
                      </div>
                      <select
                        value={memberFolders[i] || ""}
                        onChange={e => handleMemberFolderChange(i, e.target.value)}
                        style={{ ...inputSx, fontSize: 11 }}>
                        <option value="">(none — top level)</option>
                        {folderOptions.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Btn onClick={onCancel}>Cancel</Btn>
            <Btn primary disabled={!baseName.trim() || !compositeId}
              onClick={() => onConfirm({
                compositeId: parseInt(compositeId),
                baseName: baseName.trim(),
                memberFolders,
                userProject
              })}>
              <i className="ti ti-plus" /> Add Instances
            </Btn>
          </div>
        </div>
    </div>
  );
}

function InstanceRow({
  inst, idx, total, profile, cmtProfiles, userProjects, folderOptions, hasHierarchy,
  updateInstance, removeInstance, isSelected, onSelect, isDuplicateName,
}) {
  const cols = "32px 32px 160px 1fr 80px 110px 1fr 32px";
  const isEM = profile?.libType === "EquipmentModule" || profile?.libType === "EquipmentPhase";
  return (
    <div
        onClick={() => isEM && onSelect(inst.id)}
        style={{
          display: "grid", gridTemplateColumns: cols,
          padding: "5px 10px", alignItems: "center", gap: 4,
          borderBottom: idx < total - 1 ? "0.5px solid var(--color-border-tertiary)" : "none",
          cursor: isEM ? "pointer" : "default",
          background: isSelected ? "#EEEDFE" : "transparent",
        }}>
        {/* # */}
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textAlign: "right", paddingRight: 4, fontFamily: "var(--font-mono)" }}>
          {idx + 1}
        </div>
        {/* row selector indicator for EM/EPH */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          {isEM && (
            <div style={{ width: 6, height: 6, borderRadius: "50%",
              background: isSelected ? "var(--color-text-primary)" : "var(--color-border-secondary)" }} />
          )}
        </div>
        {/* Type dropdown */}
        <select value={inst.profileId} onClick={e => e.stopPropagation()}
          onChange={e => updateInstance(inst.id, "profileId", e.target.value)}
          style={{ width: "100%", padding: "3px 5px", border: "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)", fontSize: 11, fontFamily: "var(--font-mono)",
            background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
          {cmtProfiles
            .filter(p => !profile?.libType || p.libType === profile.libType)
            .map(p => <option key={p.id} value={p.id}>{p.cmType}</option>)}
        </select>
        {/* Instance name */}
        <input value={inst.instanceName} onClick={e => e.stopPropagation()}
          onChange={e => updateInstance(inst.id, "instanceName", e.target.value)}
          title={isDuplicateName ? "Duplicate name — must be unique" : undefined}
          style={{ width: "100%", padding: "3px 7px",
            border: `0.5px solid ${isDuplicateName ? "#DC2626" : "var(--color-border-secondary)"}`,
            borderRadius: "var(--border-radius-md)", fontSize: 11, fontFamily: "var(--font-mono)",
            background: isDuplicateName ? "#FEF2F2" : "var(--color-background-primary)",
            color: "var(--color-text-primary)" }} />
        {/* Sampling time */}
        <input value={inst.samplingTime} onClick={e => e.stopPropagation()}
          onChange={e => updateInstance(inst.id, "samplingTime", e.target.value)}
          style={{ width: "100%", padding: "3px 5px", border: "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)", fontSize: 11,
            background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
        {/* User project */}
        <select value={inst.userProject || ""} onClick={e => e.stopPropagation()}
          onChange={e => updateInstance(inst.id, "userProject", e.target.value)}
          style={{ width: "100%", padding: "3px 5px", border: "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)", fontSize: 11, fontFamily: "var(--font-mono)",
            background: inst.userProject ? "var(--color-background-primary)" : "#FEF3C7",
            color: "var(--color-text-primary)" }}>
          <option value="">— pick —</option>
          {userProjects.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {/* Folder — any hierarchy level, not just leaves */}
        <select value={inst.folderId || ""} onClick={e => e.stopPropagation()}
          onChange={e => updateInstance(inst.id, "folderId", e.target.value)}
          disabled={!hasHierarchy}
          style={{ width: "100%", padding: "3px 5px", border: "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)", fontSize: 11, fontFamily: "var(--font-mono)",
            background: !hasHierarchy ? "var(--color-background-secondary)"
              : (inst.folderId ? "var(--color-background-primary)" : "#FEF3C7"),
            color: "var(--color-text-primary)" }}>
          <option value="">{hasHierarchy ? "— pick —" : "(default)"}</option>
          {folderOptions.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        {/* Delete */}
        <button onClick={e => { e.stopPropagation(); removeInstance(inst.id); }}
          style={{ background: "transparent", border: "none", cursor: "pointer",
            color: "var(--color-text-secondary)", fontSize: 14, padding: 0, justifySelf: "center" }}>
          <i className="ti ti-trash" />
        </button>
    </div>
  );
}

// ── Role assignment panel (right pane for EM/EPH) ─────────────────────────────
function RolePanel({ inst, profile, instances, cmtProfiles, updateInstanceRole }) {
  if (!inst) {
    return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%",
            color: "var(--color-text-secondary)", fontSize: 12 }}>
          Select an instance to view role assignments
        </div>
    );
  }
  const rolesLoaded = profile?.roles !== null && profile?.roles !== undefined;
  const roles = profile?.roles || [];
  const isEPH = profile?.libType === "EquipmentPhase";

  return (
    <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, height: "100%", overflowY: "auto" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)" }}>{inst.instanceName}</div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>
            {profile?.cmType} · {isEPH ? "Equipment Phase" : "Equipment Module"}
          </div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
            color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 4 }}>
          Role Assignments
        </div>
        {!rolesLoaded ? (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Loading roles…</div>
        ) : roles.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>No roles defined in library for this type.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {roles.map(role => {
              const roleKind = profile?.roleKindMap?.[role] || 'cm';
              const expectedLibType = roleKind === 'em' ? 'EquipmentModule' : 'ControlModule';
              const assigned = inst.roleAssignments?.[role] || "";
              const options = instances.filter(i => {
                if (i.id === inst.id) return false;
                const p = cmtProfiles.find(x => x.id === i.profileId);
                return p?.libType === expectedLibType || (!p?.libType && roleKind === 'cm');
              });
              return (
                <div key={role}>
                  <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", marginBottom: 3 }}>
                    {role}
                    <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 6,
                      background: roleKind === 'em' ? "#E6F1FB" : "var(--color-background-secondary)",
                      color: roleKind === 'em' ? "#0C447C" : "var(--color-text-secondary)" }}>
                      {roleKind === 'em' ? 'EM' : 'CM'}
                    </span>
                  </div>
                  <select value={assigned}
                    onChange={e => updateInstanceRole(inst.id, role, e.target.value)}
                    style={{ width: "100%", padding: "4px 7px", border: "0.5px solid var(--color-border-secondary)",
                      borderRadius: "var(--border-radius-md)", fontSize: 12, fontFamily: "var(--font-mono)",
                      background: assigned ? "var(--color-background-primary)" : "#FEF3C7",
                      color: "var(--color-text-primary)" }}>
                    <option value="">— unassigned —</option>
                    {options.map(i => <option key={i.id} value={i.instanceName}>{i.instanceName} ({i.profileId})</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

// ── Instance sub-tab (list + optional role panel) ─────────────────────────────
function InstanceTab({ libType, label, instances, cmtProfiles, userProjects, folderOptions, hasHierarchy,
    addInstance, removeInstance, updateInstance, updateInstanceRole, ensureLoaded, savedProjectId, saveProjectNow, setError = () => {}, getCompositeCmType, extractMemberConnections, setInstances, compositeCmTypes, valveCommands }) {
  const [selectedId, setSelectedId] = useState(null);
  const [mapInst, setMapInst] = useState(null);   // instance whose signal-mapping modal is open
  const [connResult, setConnResult] = useState(null); // last "Generate Connections" outcome
  const [connStatus, setConnStatus] = useState({});   // instanceName → { real, dummy, total }

  // Load per-instance reconciliation counts for the grid's Connections column.
  async function loadConnStatus() {
    if (!savedProjectId) { setConnStatus({}); return; }
    try {
        const r = await getConnectionIOs(savedProjectId);
        const byInst = {};
        for (const io of (r.ios || [])) {
          const s = (byInst[io.instance_name] ||= { real: 0, dummy: 0, total: 0 });
          s.total++;
          if (io.status === "real") s.real++; else s.dummy++;
        }
        setConnStatus(byInst);
    } catch { setConnStatus({}); }
  }
  useEffect(() => { loadConnStatus(); }, [savedProjectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabInstances = instances.filter(i => {
    const p = cmtProfiles.find(x => x.id === i.profileId);
    return p?.libType === libType;
  });
  const showRolePane = libType === "EquipmentModule" || libType === "EquipmentPhase";

  const selectedInst = showRolePane ? tabInstances.find(i => i.id === selectedId) : null;
  const selectedProfile = selectedInst ? cmtProfiles.find(p => p.id === selectedInst.profileId) : null;

  // Auto-select first row when list changes and nothing is selected
  useEffect(() => {
    if (showRolePane && !selectedId && tabInstances.length > 0) {
        setSelectedId(tabInstances[0].id);
    }
    if (selectedId && !tabInstances.find(i => i.id === selectedId)) {
        setSelectedId(tabInstances[0]?.id || null);
    }
  }, [tabInstances.length]);

  // Eagerly load roles for EM/EPH instances
  useEffect(() => {
    for (const inst of tabInstances) {
        const p = cmtProfiles.find(x => x.id === inst.profileId);
        if (p && (p.libType === "EquipmentModule" || p.libType === "EquipmentPhase") && p.roles === null) {
          ensureLoaded(inst.profileId);
        }
    }
  }, [tabInstances.length]);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        {/* List pane — AG Grid */}
        <div style={{ flex: showRolePane ? "0 0 62%" : 1, display: "flex", flexDirection: "column",
            borderRight: showRolePane ? "0.5px solid var(--color-border-tertiary)" : "none", overflow: "hidden" }}>
          {connResult && (
            <div style={{
              margin: "8px 12px 0", padding: "8px 12px", borderRadius: 6, fontSize: 13,
              display: "flex", alignItems: "center", gap: 8,
              background: connResult.ok ? "#eef9f0" : "#ffeaea",
              border: `1px solid ${connResult.ok ? "#9bd5a8" : "#e88"}`,
              color: connResult.ok ? "#1c6b2e" : "#b00",
            }}>
              <span style={{ flex: 1 }}>
                {connResult.ok ? (
                  <>
                    <b>{connResult.real}</b> connected to hardware,{" "}
                    <b>{connResult.dummy}</b> unmatched (stay dummy)
                    {connResult.conflicts?.length > 0 &&
                      ` · ${connResult.conflicts.length} duplicate symbol${connResult.conflicts.length !== 1 ? "s" : ""} (bound first)`}
                    {connResult.warnings?.length > 0 &&
                      ` · ${connResult.warnings.length} type warning${connResult.warnings.length !== 1 ? "s" : ""}`}
                    {connResult.importId == null && " · no hardware import found"}
                  </>
                ) : (
                  <>Connection generation failed: {connResult.message}</>
                )}
              </span>
              <button onClick={() => setConnResult(null)}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "inherit", lineHeight: 1 }}
                title="Dismiss">×</button>
            </div>
          )}
          <InstancesGrid
            libType={libType}
            rowData={tabInstances}
            cmtProfiles={cmtProfiles}
            userProjects={userProjects}
            folderOptions={folderOptions}
            onRowUpdate={(id, field, value) => updateInstance(id, field, value)}
            onRowDelete={(id) => removeInstance(id)}
            onRowAdd={() => addInstance(libType)}
            onRowSelect={showRolePane ? (id) => setSelectedId(id === selectedId ? null : id) : undefined}
            selectedId={selectedId}
            onMapSignals={savedProjectId ? async (id) => {
              const inst = tabInstances.find(i => i.id === id);
              if (!inst) return;
              await ensureLoaded(inst.profileId);
              // Hydrate connections if marked for lazy loading (composite member with
              // empty connections — manually created or from a pre-fix save). We must
              // resolve the hydrated instance BEFORE opening the modal, otherwise the
              // modal receives the stale object with no connections and the DUMMY
              // badge / derived signal name never appear.
              let openInst = inst;
              if (inst._needsConnections && inst.compositeId != null && inst.memberIdx != null) {
                try {
                  const detail = await getCompositeCmType(inst.compositeId);
                  const connections = extractMemberConnections(detail, inst.memberIdx);
                  openInst = { ...inst, connections, _needsConnections: false };
                  setInstances(prev => prev.map(i => (i.id === inst.id ? openInst : i)));
                } catch (e) {
                  setError(e.message);
                }
              }
              setMapInst(openInst);
            } : undefined}
            onGenerateConnections={savedProjectId ? async () => {
              setConnResult(null);
              try {
                // Persist pending instance edits first so reconciliation reads the
                // latest connections from the DB (the normal save is debounced).
                if (saveProjectNow) await saveProjectNow();
                const r = await generateConnections(savedProjectId);
                setConnResult({ ok: true, ...r });
                await loadConnStatus();
              } catch (e) {
                setConnResult({ ok: false, message: e.message });
              }
            } : undefined}
            connStatusByInstance={savedProjectId ? connStatus : undefined}
          />
        </div>

        {mapInst && (
          <SignalMappingModal
            projectId={savedProjectId}
            instance={mapInst}
            profile={cmtProfiles.find(p => p.id === mapInst.profileId)}
            compositeCmTypes={compositeCmTypes}
            getCompositeCmType={getCompositeCmType}
            valveCommands={valveCommands}
            onClose={(success, data) => {
              if (success && data?.values) {
                const updatedConnections = (mapInst.connections || []).map(conn => {
                  if (conn.conn_type === 'value' && conn.target_pin && data.values[conn.target_pin] !== undefined) {
                    return { ...conn, static_value: data.values[conn.target_pin] };
                  }
                  return conn;
                });
                setInstances(prev => prev.map(i =>
                  i.id === mapInst.id ? { ...mapInst, connections: updatedConnections } : i
                ));
              }
              setMapInst(null);
            }}
          />
        )}

        {/* Role panel — only for EM / EPH */}
        {showRolePane && (
          <div style={{ flex: "0 0 38%", overflow: "hidden", background: "var(--color-background-secondary)" }}>
            <RolePanel inst={selectedInst} profile={selectedProfile}
              instances={instances} cmtProfiles={cmtProfiles}
              updateInstanceRole={updateInstanceRole} />
          </div>
        )}
      </div>
  );
}

function StepInstances({ instances, cmtProfiles, userProjects, savedProjectName, savedProjectId,
    hierarchy, compositeCmTypes, addInstance, removeInstance, updateInstance,
    updateInstanceRole, addCompositeInstances, ensureLoaded, loading, generating, saveProjectNow, onGenerate, setError,
    getCompositeCmType, extractMemberConnections, valveCommands, setInstances }) {
  const noUserProjects = !userProjects?.length;
  const folderOptions  = allFolderOptions(hierarchy || []);
  const hasHierarchy   = (hierarchy?.length || 0) > 0;
  const folderMissing  = hasHierarchy && instances.some(i => !i.folderId);
  const [compModal, setCompModal] = useState(false);

  // Sub-tab state: CM | EM | EPH
  const [instTab, setInstTab] = useState("ControlModule");
  const INST_TABS = [
    { key: "ControlModule",   label: "CM",  color: "#0C447C", bg: "#E6F1FB" },
    { key: "EquipmentModule", label: "EM",  color: "#065F46", bg: "#D1FAE5" },
    { key: "EquipmentPhase",  label: "EPH", color: "#6B21A8", bg: "#F3E8FF" },
  ];

  const countOf = libType => instances.filter(i => cmtProfiles.find(p => p.id === i.profileId)?.libType === libType).length;

  const commonTabProps = { instances, cmtProfiles, userProjects, folderOptions, hasHierarchy,
    addInstance, removeInstance, updateInstance, updateInstanceRole, ensureLoaded, savedProjectId,
    saveProjectNow, setError, getCompositeCmType, extractMemberConnections, setInstances, compositeCmTypes, valveCommands };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "0.75rem", flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 2 }}>
            Instances {savedProjectName && <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>· {savedProjectName}</span>}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {instances.length} total · {hasHierarchy ? "folder assigned per instance" : "no hierarchy defined — all instances in default folder"}
          </div>
        </div>
        {compositeCmTypes?.length > 0 && (
          <Btn onClick={() => setCompModal(true)} disabled={noUserProjects}>
            <i className="ti ti-layout-grid" /> Add Composite
          </Btn>
        )}
        <Btn primary onClick={onGenerate}
            disabled={!instances.length || !!loading || generating || noUserProjects
              || instances.some(i => !i.userProject) || folderMissing}>
          <i className="ti ti-code" /> {generating ? "Generating…" : (loading || "Generate XML")}
        </Btn>
      </div>

      {compModal && (
        <CompositeInstanceModal
          compositeCmTypes={compositeCmTypes}
          folderOptions={folderOptions}
          userProjects={userProjects}
          onConfirm={async (args) => { setCompModal(false); await addCompositeInstances(args); }}
          onCancel={() => setCompModal(false)} />
      )}

      {noUserProjects && (
        <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "var(--border-radius-md)",
            padding: "7px 12px", marginBottom: "0.5rem", fontSize: 12, color: "#92400E", flexShrink: 0 }}>
          Define at least one user project on the Projects step before adding instances.
        </div>
      )}

      {/* Sub-tab bar */}
      <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)",
          marginBottom: 0, flexShrink: 0, background: "var(--color-background-secondary)",
          borderRadius: "var(--border-radius-lg) var(--border-radius-lg) 0 0",
          border: "0.5px solid var(--color-border-tertiary)", borderBottomWidth: 0 }}>
        {INST_TABS.map(t => {
          const active = instTab === t.key;
          const count  = countOf(t.key);
          return (
            <button key={t.key} onClick={() => setInstTab(t.key)}
              style={{ padding: "7px 18px", border: "none", cursor: "pointer", fontSize: 12,
                background: "transparent", borderBottom: active ? `2px solid ${t.color}` : "2px solid transparent",
                fontWeight: active ? 600 : 400,
                color: active ? t.color : "var(--color-text-secondary)",
                marginBottom: -1, display: "flex", alignItems: "center", gap: 6 }}>
              {t.label}
              <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10,
                background: active ? t.bg : "var(--color-background-secondary)",
                color: active ? t.color : "var(--color-text-secondary)", fontWeight: 600 }}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content in a bordered box */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0,
          border: "0.5px solid var(--color-border-tertiary)",
          borderRadius: "0 0 var(--border-radius-lg) var(--border-radius-lg)" }}>
        {INST_TABS.map(t => instTab === t.key && (
          <InstanceTab key={t.key} libType={t.key} label={t.label} {...commonTabProps} />
        ))}
      </div>
    </div>
  );
}

// ── Unit-type role assignment (inline, per member) ────────────────────────────
// EM/EPH sub-members (those with library roles) of a unit member's composite.
// Used to decide whether a member row is expandable.
function emSubMembersOf(m, compDetails, cmtProfiles) {
  if (!m?.compositeCmId || !m.alias?.trim()) return [];
  const det = compDetails[m.compositeCmId];
  if (!det) return [];
  return (det.members || [])
    .map((cm, subIdx) => ({ cm, subIdx }))
    .filter(({ cm }) => {
      const prof = cmtProfiles.find(p => p.id === cm.cm_type_name);
      return prof && (prof.libType === "EquipmentModule" || prof.libType === "EquipmentPhase");
    });
}

// Inline role-assignment editor for ONE unit member's EM/EPH sub-members.
// Rendered inside the member's own expanded row (no separate window). Candidate
// targets span every sub-member in the unit type, filtered by role_kind
// (em→EquipmentModule, cm→ControlModule), matching the manual RolePanel.
function MemberRoleConfig({ m, memberIdx, members, compDetails, cmtProfiles, setRoleAssignment }) {
  const selSx = {
    padding: "4px 8px", border: "0.5px solid var(--color-border-secondary)",
    borderRadius: "var(--border-radius-md)", fontSize: 12, fontFamily: "var(--font-mono)",
    color: "var(--color-text-primary)",
  };

  // All sub-members across the unit type that can be assignment targets.
  const allTargets = [];
  for (const mm of members) {
    if (!mm.compositeCmId || !mm.alias?.trim()) continue;
    const det = compDetails[mm.compositeCmId];
    if (!det) continue;
    (det.members || []).forEach((cm, idx) => {
      const prof = cmtProfiles.find(p => p.id === cm.cm_type_name);
      allTargets.push({
        ref:     `${mm.alias}::${idx}`,
        libType: prof?.libType || "ControlModule",
        label:   `${mm.alias} · ${cm.cm_type_name}`,
      });
    });
  }

  const emSubs = emSubMembersOf(m, compDetails, cmtProfiles);
  if (!emSubs.length) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "6px 2px 10px 26px" }}>
      {emSubs.map(({ cm, subIdx }) => {
        const prof      = cmtProfiles.find(p => p.id === cm.cm_type_name);
        const roles     = prof?.roles;
        const selfRef   = `${m.alias}::${subIdx}`;
        const kindBadge = prof?.libType === "EquipmentPhase" ? "EPH" : "EM";
        return (
          <div key={subIdx}>
            <div style={{ fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)", marginBottom: 5 }}>
              {cm.cm_type_name}
              <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 6, background: "#E6F1FB", color: "#0C447C" }}>{kindBadge}</span>
            </div>
            {roles == null ? (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Loading roles…</div>
            ) : roles.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>No roles defined in library for this type.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {roles.map(role => {
                  const roleKind = prof?.roleKindMap?.[role] || "cm";
                  const candidates = allTargets.filter(t =>
                    t.ref !== selfRef &&
                    (roleKind === "em" ? t.libType === "EquipmentModule" : t.libType === "ControlModule")
                  );
                  const cur    = (m.roleAssignments || []).find(r => (r.sourceMemberIdx ?? 0) === subIdx && r.role === role);
                  const curRef = cur ? `${cur.targetAlias}::${cur.targetMemberIdx ?? 0}` : "";
                  return (
                    <div key={role} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 150, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
                        {role}
                        <span style={{ marginLeft: 5, fontSize: 9, padding: "0 4px", borderRadius: 5, background: roleKind === "em" ? "#E6F1FB" : "var(--color-background-secondary)", color: roleKind === "em" ? "#0C447C" : "var(--color-text-secondary)" }}>
                          {roleKind === "em" ? "EM" : "CM"}
                        </span>
                      </div>
                      <select value={curRef} onChange={e => setRoleAssignment(memberIdx, subIdx, role, e.target.value)}
                        style={{ ...selSx, flex: 1, background: curRef ? "var(--color-background-primary)" : "#FEF3C7" }}>
                        <option value="">— unassigned —</option>
                        {candidates.map(t => <option key={t.ref} value={t.ref}>{t.label}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Compact preview of a member's role assignments, shown on the collapsed row.
function MemberRolePreview({ m, members, compDetails, cmtProfiles }) {
  const labelFor = (alias, idx) => {
    const mm = members.find(x => x.alias === alias);
    const det = mm && compDetails[mm.compositeCmId];
    const cm = det?.members?.[idx];
    return cm ? `${alias} · ${cm.cm_type_name}` : `${alias}`;
  };
  const emSubs = emSubMembersOf(m, compDetails, cmtProfiles);
  const items = [];
  let total = 0, assigned = 0;
  for (const { cm, subIdx } of emSubs) {
    const prof = cmtProfiles.find(p => p.id === cm.cm_type_name);
    for (const role of (prof?.roles || [])) {
      total++;
      const cur = (m.roleAssignments || []).find(r => (r.sourceMemberIdx ?? 0) === subIdx && r.role === role);
      if (cur) { assigned++; items.push({ role, label: labelFor(cur.targetAlias, cur.targetMemberIdx ?? 0) }); }
    }
  }
  if (total === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden", whiteSpace: "nowrap" }}>
      {assigned === 0 ? (
        <span style={{ fontSize: 10, color: "#B45309" }}>{total} role{total > 1 ? "s" : ""} · none assigned</span>
      ) : (
        <>
          {items.map(a => (
            <span key={a.role} style={{ fontSize: 10, fontFamily: "var(--font-mono)", padding: "1px 6px", borderRadius: 10,
              background: "var(--color-background-secondary)", color: "var(--color-text-secondary)" }}>
              {a.role} → {a.label}
            </span>
          ))}
          {assigned < total && <span style={{ fontSize: 10, color: "#B45309" }}>+{total - assigned} unassigned</span>}
        </>
      )}
    </div>
  );
}

// ── Step 2: Unit Types ────────────────────────────────────────────────────────
const UNIT_TABS = [
  { key: "config",    label: "Unit Configuration" },
  { key: "instances", label: "Unit Instances" },
];

function StepUnitTypes({
  unitTypes, unitInstances, cmtProfiles, compositeCmTypes, userProjects,
  savedProjectId, ensureLoaded, loading, setError,
  onUnitTypesChange, onUnitInstancesChange, onExpand,
  unitConnections, cmTypeVarCache, onSaveConnections, onLoadConnections,
}) {
  const [unitTab, setUnitTab]               = useState("config");
  const [selectedTypeId, setSelectedTypeId] = useState(null);
  const [editDraft, setEditDraft]           = useState(null);   // { name, description, members[] }
  const [addModal, setAddModal]             = useState(false);  // show add-unit-instance modal
  const [newUnitName, setNewUnitName]       = useState("");
  const [newUnitTypeId, setNewUnitTypeId]   = useState("");
  const [newUserProject, setNewUserProject] = useState("");
  const [newParentPath, setNewParentPath]   = useState("");
  const [busy, setBusy]                     = useState(false);
  const [toast, setToast]                   = useState("");     // success message
  const [compDetails, setCompDetails]       = useState({});     // compositeId -> { members: [...] }
  const [openMembers, setOpenMembers]       = useState({});     // member idx -> expanded bool
  const [importModalOpen, setImportModalOpen] = useState(false); // show import unit type modal
  const [spirographOpen, setSpirogramOpen]  = useState(false);   // show spirograph modal

  // Local editable copy of unit instances so typing in the grid is instant.
  // The prop is the source of truth (server state); we mirror it locally and
  // debounce persistence so each keystroke doesn't fire two network round-trips.
  const [localUnitInstances, setLocalUnitInstances] = useState(unitInstances);
  const uiSaveTimers = useRef({});   // instanceId -> debounce timeout
  useEffect(() => { setLocalUnitInstances(unitInstances); }, [unitInstances]);

  // When the global composite list changes (e.g. a composite was deleted), clear any
  // stale compositeCmId values from the open draft so the dropdown shows "— pick composite —"
  // instead of a phantom entry that no longer exists.
  useEffect(() => {
    if (!editDraft) return;
    const validIds = new Set((compositeCmTypes || []).map(c => c.id));
    const hasStale = editDraft.members.some(m => m.compositeCmId != null && !validIds.has(m.compositeCmId));
    if (!hasStale) return;
    setEditDraft(d => ({
      ...d,
      members: d.members.map(m =>
        m.compositeCmId != null && !validIds.has(m.compositeCmId)
          ? { ...m, compositeCmId: null, roleAssignments: [] }
          : m
      ),
    }));
  }, [compositeCmTypes]);

  // Auto-select first unit type when unitTypes changes
  useEffect(() => {
    if (unitTypes.length > 0 && !selectedTypeId) {
      selectType(unitTypes[0].id);
    }
  }, [unitTypes]);

  // Load a composite's sub-members into compDetails, and ensure roles are loaded
  // for any EM/EPH sub-members so the role-assignment editor can render them.
  async function loadCompositeMeta(compositeId) {
    if (!compositeId) return;
    try {
      const detail = await getCompositeCmType(compositeId);
      setCompDetails(prev => ({ ...prev, [compositeId]: detail }));
      for (const cm of (detail.members || [])) {
        const prof = cmtProfiles.find(p => p.id === cm.cm_type_name);
        if (prof && (prof.libType === "EquipmentModule" || prof.libType === "EquipmentPhase")) {
          ensureLoaded?.(cm.cm_type_name);
        }
      }
    } catch (_) { /* ignore — UI degrades to no roles */ }
  }

  async function selectType(id) {
    setSelectedTypeId(id);
    try {
      const detail = await getUnitType(id);
      setEditDraft({
        name:        detail.name,
        description: detail.description || "",
        members:     detail.members.map(m => ({
          alias:           m.alias,
          cmTypeName:      m.cmTypeName || '',
          compositeCmId:   m.compositeCmId || null,
          roleAssignments: (m.roleAssignments || []).map(r => ({
            sourceMemberIdx: r.sourceMemberIdx ?? 0,
            role:            r.role,
            targetAlias:     r.targetAlias ?? r.assignedAlias ?? "",
            targetMemberIdx: r.targetMemberIdx ?? 0,
          })),
        })),
      });
      // Load connections and variables for the unit type
      // This ensures connections are always fresh when selecting a unit type
      await onLoadConnections(id);
      // Preload composite metadata for all members so role editors render immediately.
      const ids = [...new Set(detail.members.map(m => m.compositeCmId).filter(Boolean))];
      for (const cid of ids) loadCompositeMeta(cid);
    } catch (e) { setError(e.message); }
  }

  async function handleCreateType() {
    const name = `Unit Type ${unitTypes.length + 1}`;
    setBusy(true);
    try {
      const ut = await createUnitType({ name, description: "" });
      await onUnitTypesChange();
      selectType(ut.id);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleSaveType() {
    if (!selectedTypeId || !editDraft) return;
    setBusy(true);
    try {
      await updateUnitType(selectedTypeId, editDraft);
      await onUnitTypesChange();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteType(id) {
    if (!confirm("Delete this unit type?")) return;
    setBusy(true);
    try {
      await deleteUnitType(id);
      if (selectedTypeId === id) { setSelectedTypeId(null); setEditDraft(null); }
      await onUnitTypesChange();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function addMember() {
    setEditDraft(d => ({
      ...d,
      members: [...d.members, { alias: "", compositeCmId: null, roleAssignments: [] }],
    }));
  }

  function updateMember(idx, key, val) {
    setEditDraft(d => ({
      ...d,
      members: d.members.map((m, i) => {
        if (i !== idx) return m;
        // Changing the composite invalidates this member's role assignments
        // (sub-member indices no longer line up).
        if (key === "compositeCmId") return { ...m, compositeCmId: val, roleAssignments: [] };
        return { ...m, [key]: val };
      }),
    }));
    if (key === "compositeCmId" && val) loadCompositeMeta(val);
  }

  function removeMember(idx) {
    setEditDraft(d => ({ ...d, members: d.members.filter((_, i) => i !== idx) }));
  }

  // Set (or clear) the role assignment for a given EM/EPH sub-member of a unit member.
  // targetRef is "" to clear, or "<targetAlias>::<targetMemberIdx>".
  function setRoleAssignment(memberIdx, sourceMemberIdx, role, targetRef) {
    setEditDraft(d => ({
      ...d,
      members: d.members.map((m, i) => {
        if (i !== memberIdx) return m;
        const rest = (m.roleAssignments || []).filter(
          r => !((r.sourceMemberIdx ?? 0) === sourceMemberIdx && r.role === role)
        );
        if (!targetRef) return { ...m, roleAssignments: rest };
        const [targetAlias, tIdx] = targetRef.split("::");
        return {
          ...m,
          roleAssignments: [...rest, {
            sourceMemberIdx,
            role,
            targetAlias,
            targetMemberIdx: parseInt(tIdx, 10) || 0,
          }],
        };
      }),
    }));
  }

  // Ensure roles are loaded for a given CM type name

  async function handleAddUnitInstance() {
    if (!newUnitName.trim() || !newUnitTypeId) return;
    setBusy(true);
    try {
      await addUnitInstance(savedProjectId, {
        unit_type_id: parseInt(newUnitTypeId),
        unit_name:    newUnitName.trim(),
        user_project: newUserProject,
        parent_path:  newParentPath.trim(),
      });
      setAddModal(false); setNewUnitName(""); setNewUnitTypeId(""); setNewUserProject(""); setNewParentPath("");
      await onUnitInstancesChange();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function handleUpdateUnitInstance(id, field, value) {
    // 1. Update local state immediately so the input reflects the keystroke
    //    with zero latency (no waiting on the network).
    setLocalUnitInstances(prev => prev.map(u => u.id === id ? { ...u, [field]: value } : u));

    // 2. Debounce the server write. Only the latest value per instance is sent,
    //    ~500ms after the user stops typing — avoiding a round-trip per keystroke.
    if (uiSaveTimers.current[id]) clearTimeout(uiSaveTimers.current[id]);
    uiSaveTimers.current[id] = setTimeout(() => {
      delete uiSaveTimers.current[id];
      // Read the freshest local row (covers the case where several fields were
      // edited during the debounce window) so no field is reverted to a stale value.
      setLocalUnitInstances(cur => {
        const ui = cur.find(u => u.id === id);
        if (ui) {
          updateUnitInstance(savedProjectId, id, {
            unit_name:    ui.unit_name,
            user_project: ui.user_project || '',
            parent_path:  ui.parent_path  || '',
          })
            .then(() => onUnitInstancesChange())
            .catch(e => setError(e.message));
        }
        return cur;   // no state change — we only read the latest snapshot
      });
    }, 500);
  }

  async function handleDeleteUnitInstance(id) {
    setBusy(true);
    try {
      await deleteUnitInstance(savedProjectId, id);
      await onUnitInstancesChange();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  // Ensure connections are loaded when a unit type is selected
  // Use a ref to track which type's connections we've loaded to avoid redundant calls
  const loadedConnectionsRef = useRef(new Set());
  useEffect(() => {
    if (selectedTypeId && !loadedConnectionsRef.current.has(selectedTypeId)) {
      loadedConnectionsRef.current.add(selectedTypeId);
      onLoadConnections(selectedTypeId).catch(() => {
        // If loading fails, remove from cache so we can retry next time
        loadedConnectionsRef.current.delete(selectedTypeId);
      });
    }
  }, [selectedTypeId]);

  const colLeft  = { width: 220, minWidth: 180, borderRight: "0.5px solid var(--color-border-tertiary)", display: "flex", flexDirection: "column" };
  const colRight = { flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 };
  const inputSx  = { padding: "4px 8px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", fontSize: 12, fontFamily: "var(--font-mono)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: "100%" };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* ── Tab bar ── */}
      <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 0 }}>
        {UNIT_TABS.map(t => {
          const active = unitTab === t.key;
          return (
            <button key={t.key} onClick={() => setUnitTab(t.key)}
              style={{ padding: "7px 18px", border: "none", background: "transparent",
                cursor: "pointer", fontSize: 13, fontWeight: active ? 500 : 400,
                color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                borderBottom: active ? "2px solid var(--color-text-primary)" : "2px solid transparent",
                marginBottom: -1 }}>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ── Unit Configuration Tab ── */}
      {unitTab === "config" && (
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Left: type list */}
        <div style={colLeft}>
          <div style={{ padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)" }}>Unit Types</span>
            <div style={{ display: "flex", gap: 4 }}>
              <Btn onClick={() => setImportModalOpen(true)} disabled={busy} title="Import from PCS7"><i className="ti ti-upload" /></Btn>
              <Btn onClick={handleCreateType} disabled={busy}><i className="ti ti-plus" /></Btn>
            </div>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {unitTypes.length === 0 && (
              <div style={{ padding: "12px 10px", fontSize: 12, color: "var(--color-text-secondary)" }}>No unit types yet.</div>
            )}
            {unitTypes.map(ut => (
              <div key={ut.id} onClick={() => selectType(ut.id)}
                style={{ display: "flex", alignItems: "center", padding: "6px 10px", cursor: "pointer", gap: 6,
                  background: selectedTypeId === ut.id ? "var(--color-background-secondary)" : "transparent",
                  borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-mono)" }}>{ut.name}</span>
                <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{ut.member_count}m</span>
                <button onClick={e => { e.stopPropagation(); handleDeleteType(ut.id); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 0, fontSize: 13 }}>
                  <i className="ti ti-trash" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Right: type editor */}
        <div style={colRight}>
          {!editDraft ? (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 20 }}>Select a unit type or create a new one.</div>
          ) : (
            <>
              {/* Name + description */}
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Name</div>
                  <input value={editDraft.name} onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))} style={inputSx} />
                </div>
                <div style={{ flex: 2 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Description</div>
                  <input value={editDraft.description} onChange={e => setEditDraft(d => ({ ...d, description: e.target.value }))} style={inputSx} />
                </div>
              </div>

              {/* Members table — composite CM types only; folder path comes from the composite definition */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-secondary)", marginBottom: 6 }}>Members</div>
                {(compositeCmTypes || []).length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>
                    No composite CM types defined yet — create them in Library → Composite CM Types first.
                  </div>
                )}
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "var(--color-background-secondary)" }}>
                      {["", "Alias", "Composite CM Type", ""].map((h, hi) => (
                        <th key={hi} style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500, fontSize: 11, color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-secondary)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {editDraft.members.map((m, idx) => {
                      const selComp   = (compositeCmTypes || []).find(c => c.id === m.compositeCmId);
                      const hasRoles  = emSubMembersOf(m, compDetails, cmtProfiles).length > 0;
                      const isOpen    = hasRoles && !!openMembers[idx];
                      return (
                        <React.Fragment key={idx}>
                        <tr style={{ borderBottom: isOpen ? "none" : "0.5px solid var(--color-border-tertiary)" }}>
                          <td style={{ padding: "3px 4px", width: 22, textAlign: "center" }}>
                            {hasRoles && (
                              <button onClick={() => setOpenMembers(o => ({ ...o, [idx]: !o[idx] }))}
                                title="Role assignments"
                                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 0 }}>
                                <i className={`ti ti-chevron-${isOpen ? "down" : "right"}`} style={{ fontSize: 14 }} />
                              </button>
                            )}
                          </td>
                          <td style={{ padding: "3px 4px" }}>
                            <input value={m.alias} onChange={e => updateMember(idx, "alias", e.target.value)}
                              style={{ ...inputSx, width: 90 }} placeholder="e.g. AO1" />
                          </td>
                          <td style={{ padding: "3px 4px" }}>
                            <select value={m.compositeCmId || ""}
                              onChange={e => updateMember(idx, "compositeCmId", e.target.value ? parseInt(e.target.value) : null)}
                              style={inputSx}>
                              <option value="">— pick composite —</option>
                              {(compositeCmTypes || []).map(c => (
                                <option key={c.id} value={c.id}>{c.name} ({c.member_count} types)</option>
                              ))}
                            </select>
                            {selComp && !isOpen && (
                              hasRoles ? (
                                <div style={{ marginTop: 2 }}>
                                  <MemberRolePreview m={m} members={editDraft.members} compDetails={compDetails} cmtProfiles={cmtProfiles} />
                                </div>
                              ) : (
                                <div style={{ fontSize: 10, color: "#7F77DD", marginTop: 1 }}>
                                  Folder paths from composite definition
                                </div>
                              )
                            )}
                          </td>
                          <td style={{ padding: "3px 4px", textAlign: "center" }}>
                            <button onClick={() => removeMember(idx)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)" }}>
                              <i className="ti ti-x" />
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr style={{ borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)" }}>
                            <td colSpan={4} style={{ padding: "2px 8px 6px 8px" }}>
                              <MemberRoleConfig
                                m={m} memberIdx={idx} members={editDraft.members}
                                compDetails={compDetails} cmtProfiles={cmtProfiles}
                                setRoleAssignment={setRoleAssignment} />
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                <Btn onClick={addMember} style={{ marginTop: 6 }}><i className="ti ti-plus" /> Add Member</Btn>
              </div>

              <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--color-border-secondary)', paddingTop: '1.5rem' }}>
                <UnitConnectionsEditor
                  unitType={{ name: editDraft.name, members: editDraft.members }}
                  compositeCmTypes={compositeCmTypes}
                  connections={unitConnections[selectedTypeId] || []}
                  cmTypeVars={cmTypeVarCache}
                  onSave={(connections) => onSaveConnections(selectedTypeId, connections)}
                  onCancel={() => {}}
                  loading={loading}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: '1.5rem', gap: '0.75rem' }}>
                <Btn onClick={() => setSpirogramOpen(true)} disabled={busy || editDraft.members.length === 0}>
                  <i className="ti ti-geometry" /> View Spirograph
                </Btn>
                <Btn primary onClick={handleSaveType} disabled={busy || !editDraft.name.trim()}>
                  <i className="ti ti-device-floppy" /> Save Unit Type
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
      )}

      {/* ── Unit Instances Tab ── */}
      {unitTab === "instances" && (
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", flex: 1 }}>
            Unit Instances — {savedProjectId ? "" : "(save a project first)"}
          </span>
          <Btn onClick={() => { setNewUnitName(""); setNewUnitTypeId(unitTypes[0]?.id || ""); setNewUserProject(""); setNewParentPath(""); setAddModal(true); }}
            disabled={!savedProjectId || busy}>
            <i className="ti ti-plus" /> Add Unit Instance
          </Btn>
          <Btn primary onClick={async () => { await onExpand(); showToast("Instances generated successfully."); }}
            disabled={!savedProjectId || busy || unitInstances.length === 0}>
            <i className="ti ti-player-play" /> Generate Instances
          </Btn>
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {localUnitInstances.length === 0 ? (
            <div style={{ padding: "12px", fontSize: 12, color: "var(--color-text-secondary)" }}>
              No unit instances yet. Add instances then click Generate Instances.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--color-background-secondary)" }}>
                  {["Unit Name", "Unit Type", "Parent Path (e.g. rIX/DE1)", "User Project", ""].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "5px 10px", fontWeight: 500, fontSize: 11, color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-secondary)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {localUnitInstances.map(ui => (
                  <tr key={ui.id} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                    <td style={{ padding: "4px 6px" }}>
                      <input value={ui.unit_name} onChange={e => handleUpdateUnitInstance(ui.id, 'unit_name', e.target.value)}
                        style={{ ...inputSx, width: 90 }} />
                    </td>
                    <td style={{ padding: "4px 6px", color: "var(--color-text-secondary)", fontSize: 11 }}>{ui.unit_type_name}</td>
                    <td style={{ padding: "4px 6px" }}>
                      <input value={ui.parent_path || ""} onChange={e => handleUpdateUnitInstance(ui.id, 'parent_path', e.target.value)}
                        placeholder="rIX/DE1" style={{ ...inputSx, width: 130 }} />
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <select value={ui.user_project || ""} onChange={e => handleUpdateUnitInstance(ui.id, 'user_project', e.target.value)}
                        style={{ ...inputSx, width: 110 }}>
                        <option value="">— none —</option>
                        {userProjects.map(up => <option key={up} value={up}>{up}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      <button onClick={() => handleDeleteUnitInstance(ui.id)} disabled={busy}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 14 }}>
                        <i className="ti ti-trash" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#166534", color: "#fff",
            padding: "10px 20px", borderRadius: "var(--border-radius-md)", fontSize: 13, fontWeight: 500,
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)", zIndex: 1000 }}>
          <i className="ti ti-circle-check" style={{ marginRight: 6 }} />{toast}
        </div>
      )}

      {/* Add unit instance modal */}
      {addModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: "var(--border-radius-lg)", padding: 20, width: 380, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Add Unit Instance</div>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Unit Type</div>
              <select value={newUnitTypeId} onChange={e => setNewUnitTypeId(e.target.value)} style={inputSx}>
                <option value="">— select —</option>
                {unitTypes.map(ut => <option key={ut.id} value={ut.id}>{ut.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Unit Name (e.g. U010)</div>
              <input value={newUnitName} onChange={e => setNewUnitName(e.target.value)} style={inputSx} placeholder="U010" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Parent Path (e.g. rIX/DE1)</div>
              <input value={newParentPath} onChange={e => setNewParentPath(e.target.value)} style={inputSx} placeholder="rIX/DE1" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>User Project</div>
              <select value={newUserProject} onChange={e => setNewUserProject(e.target.value)} style={inputSx}>
                <option value="">— none —</option>
                {userProjects.map(up => <option key={up} value={up}>{up}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <Btn onClick={() => setAddModal(false)}>Cancel</Btn>
              <Btn primary onClick={handleAddUnitInstance} disabled={busy || !newUnitName.trim() || !newUnitTypeId}>Add</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Import Unit Type Modal */}
      <UnitTypeImportModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        compositeCmTypes={compositeCmTypes}
        onImportSuccess={(result) => {
          setImportModalOpen(false);
          setToast(`Unit type "${result.unitName}" imported successfully!`);
          onUnitTypesChange();
        }}
      />

      {/* Spirograph Modal — full screen */}
      {spirographOpen && (
        <div style={{ position: "fixed", inset: 0, background: "var(--color-background-primary)", display: "flex", flexDirection: "column", zIndex: 1000 }}>
          <UnitTypeSpirograph
            unitTypeName={editDraft?.name || "Unit Type"}
            members={editDraft?.members || []}
            compositeCmTypes={compositeCmTypes}
            compDetails={compDetails}
            cmtProfiles={cmtProfiles}
            onClose={() => setSpirogramOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

// ── Step 5: Output ───────────────────────────────────────────────────────────
function StepOutput({ result, onBack }) {
  const outputs = result.outputs || [];
  const [openIdx, setOpenIdx] = useState(outputs.length === 1 ? 0 : -1);

  function downloadOne(out) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([out.xml], { type: "application/xml" }));
    a.download = `${out.userProject}.xml`;
    a.click();
  }
  function downloadAll() { outputs.forEach(downloadOne); }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1rem" }}>
        <Btn onClick={onBack}><i className="ti ti-arrow-left" /> Back</Btn>
        <span style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>
          {outputs.length} XML file{outputs.length === 1 ? "" : "s"} generated
        </span>
        {outputs.length > 1 && (
          <Btn primary onClick={downloadAll}><i className="ti ti-download" /> Download all</Btn>
        )}
      </div>

      <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
        {outputs.map((out, idx) => (
          <OutputRow key={out.userProject} out={out}
            open={openIdx === idx} onToggle={() => setOpenIdx(openIdx === idx ? -1 : idx)}
            onDownload={() => downloadOne(out)}
            isLast={idx === outputs.length - 1} />
        ))}
      </div>
    </div>
  );
}

function OutputRow({ out, open, onToggle, onDownload, isLast }) {
  const [copied, setCopied] = useState(false);
  const { userProject, xml, stats } = out;
  const lines = xml.split(/\r?\n/);

  function copy() {
    navigator.clipboard.writeText(xml).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div style={{ borderBottom: isLast ? "none" : "0.5px solid var(--color-border-tertiary)" }}>
      <div onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", cursor: "pointer",
          background: open ? "var(--color-background-secondary)" : "transparent" }}>
        <i className={`ti ti-chevron-${open ? "down" : "right"}`} style={{ fontSize: 14, color: "var(--color-text-secondary)" }} />
        <span style={{ flex: 1, fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 500 }}>{userProject}.xml</span>
        <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
          {stats.blocks} blocks · {stats.vars} vars · {stats.msgs} msgs · {stats.sizeKb} KB
        </span>
        <Btn onClick={e => { e.stopPropagation(); copy(); }}>
          <i className="ti ti-copy" /> {copied ? "Copied!" : "Copy"}
        </Btn>
        <Btn primary onClick={e => { e.stopPropagation(); onDownload(); }}>
          <i className="ti ti-download" /> Download
        </Btn>
      </div>
      {open && (
        <pre style={{ overflowY: "auto", overflowX: "auto", maxHeight: 360, margin: 0, padding: "0.75rem 1rem",
            fontSize: 11, lineHeight: 1.6, fontFamily: "var(--font-mono)",
            color: "var(--color-text-secondary)", background: "transparent",
            borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          {lines.slice(0, 150).join("\n")}
          {lines.length > 150 && `\n\n… ${(lines.length - 150).toLocaleString()} more lines`}
        </pre>
      )}
    </div>
  );
}

// ── Shared components ────────────────────────────────────────────────────────
function SLabel({ text, top }) {
  return <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textTransform: "uppercase",
    letterSpacing: "0.05em", fontWeight: 500, margin: `${top ? "1rem" : 0} 0 8px` }}>{text}</div>;
}

function BlockRow({ block, on, required, onToggle }) {
  return (
    <div onClick={required ? undefined : onToggle}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0",
        borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: required ? "default" : "pointer" }}>
      <div style={{ width: 34, height: 18, borderRadius: 9, flexShrink: 0, position: "relative",
          background: on ? "#7F77DD" : "var(--color-border-secondary)", opacity: required ? 0.6 : 1, transition: "background 0.15s" }}>
        <div style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 14, height: 14,
            borderRadius: "50%", background: "white", transition: "left 0.15s" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 500 }}>{block.name}</span>
        {block.comment && <span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginLeft: 6 }}>{block.comment}</span>}
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8,
            background: required ? "#E6F1FB" : "var(--color-background-secondary)",
            color: required ? "#0C447C" : "var(--color-text-secondary)", fontWeight: 500 }}>
          {required ? "req" : "opt"}
        </span>
        {block.msgs?.length > 0 && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: "#FAEEDA", color: "#854F0B", fontWeight: 500 }}>{block.msgs.length}msg</span>}
        <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{block.vars?.length || 0}v</span>
      </div>
    </div>
  );
}

function Btn({ onClick, primary, disabled, children, style }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ padding: "7px 18px", borderRadius: "var(--border-radius-md)",
        border: primary ? "none" : "0.5px solid var(--color-border-secondary)",
        cursor: disabled ? "not-allowed" : "pointer", fontSize: 13, fontWeight: primary ? 500 : 400,
        background: primary ? "var(--color-accent)" : "transparent",
        color: primary ? "white" : "var(--color-text-primary)",
        opacity: disabled ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6,
        transition: "all 0.2s ease",
        ...style }}>
      {children}
    </button>
  );
}

