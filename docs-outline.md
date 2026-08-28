# PCS7 Matrix Generator — Documentation Outline

## App summary

**What it does:** A configuration tool for Siemens PCS7 industrial control system projects. It lets engineers import plant IO/signal lists and equipment data from Excel, build an ISA-S88 style plant hierarchy, manage a library of reusable Control Module / Equipment Module / Equipment Phase types, configure PLC hardware (stations, racks, slots, fieldbuses, MRP redundancy), map signals to instances, and generate the final PCS7 XML import files (plus `.cfg` hardware files).

**Primary users:** Automation/process control engineers configuring a PCS7 project — a single shared workspace, not a multi-tenant SaaS product.

**Login:** None. No authentication or authorization exists anywhere in the app — every user sees the same shared data and can perform every action. This will be called out plainly on the Getting Started page and is **not** something the manual should imply exists.

**Navigation model (important for docs structure):** This is not a traditional multi-page site — it's a single-page wizard/workbench with 9 steps navigated via a persistent sidebar. The URL bar reflects the active step (e.g. `/instances`), but there's no separate page load per step. The docs site should mirror these 9 steps as top-level sidebar sections, in this order, since that's also the natural order of the workflow.

---

## Screens (in workflow order)

### 1. Projects (`/projects`)
Create/load/delete saved projects. Each project can contain multiple "user projects" (AS01, AS02, … — one PLC/AS station's worth of config, and one generated XML output per user project).

Actions:
- Create new project (name field)
- Click a project row to load it as the active project
- Delete a project (confirms)
- Add a user project (auto-named AS01, AS02, …)
- Rename a user project inline
- Remove a user project (confirms if instances reference it)
- Upload a PCS7 XML export per user project to auto-fill hardware IDs (`UserProjectConfigModal`)
- Manually edit the 12 PCS7 ID fields per user project (Project Name/ID, Device Name/ID, CPU ID, Process Cell/ID, Unit Name/ID, CM Folder ID, Export User, Unit Author) and save

### 2. IO Import (`/io-import`)
Upload the plant's Control Module IO/signal list (Excel) and turn it into reviewed, promotable tag data.

Sub-tabs: Function Mapping, Upload, Column Mapping, Hierarchy, Review, Auto Workflow

Actions:
- Upload / drag-drop an Excel file, pick a sheet
- Reimport (replace file for an existing import, keeping headers)
- Delete an import
- Map Excel columns to internal fields (tag, description, signal type, CM type, AS assignment, etc.)
- Save / apply / delete named column-map presets
- Build folder hierarchy automatically from tag structure
- Define/save named function→CM-type auto-assignment mapping presets
- Review each tag row: approve, reject, edit; "Approve All"
- Promote reviewed rows into real project instances
- Run the "Auto Workflow" one-click pipeline (upload → map → assign → promote)
- Hand off AS-assigned rows to HW Config for hardware ingestion

### 3. EPH/EM Import (`/eph-em-import`)
A parallel import pipeline for Equipment Phase / Equipment Module rows (as opposed to Control Module rows).

Sub-tabs: Type Mappings, Upload, Review

Actions:
- Create/update/delete type-mapping configs (Excel value → composite CM type)
- Upload the EPH/EM Excel list; choose unit column and type-mapping config
- Review rows: patch, reject, run auto-assignment
- Resolve instance-naming conflicts during promotion
- Promote import into real Unit Instances
- Delete an EPH/EM import

### 4. Library (`/library`)
Manage the master catalog of CM/EM/EPH types, parsed from a Siemens `SIE_LIB.XML` file.

Sub-tabs: Upload Library, Type Configuration, Composite CM Types, Mode Commands, Audit Log

Actions:
- Upload / replace `SIE_LIB.XML`
- Search/filter CM/EM/EPH types
- View and toggle a type's optional blocks (including "conditional" flag)
- Edit a variable's default value; toggle whether a variable is usable in mappings
- Remove a type from the library
- Create/select/delete a "composite" type (a template combining multiple CM types)
- Add/remove/reorder composite members; wire inter-member connections
- Configure a composite's valve-command matrix (columns and mode rows)
- Configure per-member auto-wiring rules to hardware inputs
- Edit the mode-command name→integer lookup table
- View a filterable audit log of all library changes (who, when, before/after)

### 5. Unit Types (`/unit-types`)
Define reusable S88 "Unit Type" templates and manage concrete Unit Instances per project.

Sub-tabs: Unit Configuration, Unit Instances

Actions:
- Import a unit type from a PCS7 export
- Create / select / delete a unit type; edit name and description
- Add/remove members (composite CM type + alias) to a unit type
- Assign EM/EPH roles per member
- View a visual "spirograph" diagram of the unit type
- Configure unit-type-level connections
- Add a Unit Instance (pick unit type, name, parent path, user project)
- Inline-edit an instance's name / parent path / user project
- Delete a unit instance
- "Generate Instances" — expand unit instances into concrete CM/EM/EPH instances (resolves naming conflicts first)

### 6. Hierarchy (`/hierarchy`)
Build the ISA-S88 plant folder tree that instances and hardware are filed under.

Actions:
- Add a root folder / add a subfolder to any folder
- Edit a folder's name inline
- Set a folder's S88 type (ProcessCell / Unit / EMOD / plain)
- Expand/collapse the tree
- Delete a folder (cascades to descendants; confirms and clears folder assignment if instances reference the subtree)
- Edit a description per Unit in the side panel

### 7. Instances (`/instances`)
The central matrix/grid — the main working screen for creating and configuring instances.

Sub-tabs: CM, EM, EPH

Actions:
- Add Composite (create a linked batch of instances from a composite type)
- Run Reconciliation (match instances' placeholder IOs against imported hardware signals)
- View Reconciliation Overview
- Generate XML (primary action; disabled until every instance has a user project, controller, and folder)
- Add / delete a row in the grid
- Inline-edit CM type, instance name (validates uniqueness), sampling time, user project, hardware controller, hierarchy folder
- Map Signals — bind each block's input/output to a hardware signal, edit static values, edit derived-value and matrix-cell overrides
- Generate Connections (auto-reconcile the whole project)
- View Exported Blocks (preview)
- Assign roles for EM/EPH instances (which CM/EM instances fill named roles)
- Accept / Revert to Dummy per instance, or in bulk from the Overview modal

### 8. HW Config (`/hw-config`)
Import and edit PLC hardware configuration.

Sections: Import, Catalogue, and per-controller Controller / Configuration / MRP tabs

Actions:
- Upload a baseline `.CFG` file and an IO-list Excel; "Backfill from CFG"
- Map IO-list columns; review/apply staged rows
- Manage the module template catalogue (add/edit templates, signal types, slot compatibility rules, import templates from a `.cfg`)
- Delete a catalogue template (checks usage first)
- Edit controller fields (name, station type); manage fieldbuses; delete a controller
- Add / copy / delete a station; bulk-select stations for bulk delete/approve
- Add / delete a slot/module on a station
- Edit station name, IP address; edit slot channel parameters, potential group, PIP mapping, PA profile, subslot profile
- View the Symbol Table (all configured signals)
- Generate CFG (all / selected / approved only) and download it, with summary stats
- Auto-slot configuration for ET200SP-style stations
- Configure MRP ring topology (assign roles, draw port links on a canvas or via a form, set domain/fieldbus)
- Save and download MRP-augmented CFG

### 9. Generate (`/generate`)
View and download the generated PCS7 XML output.

Actions:
- Expand/collapse a preview (first 150 lines) of each generated XML file
- Copy XML to clipboard
- Download a single XML
- Download all (when multiple user projects were generated)
- Back to Instances

---

## User roles / permissions

**None.** There is no login, no authentication, and no authorization anywhere in the app (confirmed: no auth middleware, no auth dependencies, no per-route permission checks, no per-project ownership). It is a single shared workspace — anything one user can do, every user can do. The audit log records a free-text "changed by" name for traceability only; it is not tied to a real login.

---

## Notes for the manual

- Because the app is a single-page wizard, "screens" in the manual = the 9 sidebar steps, not separate URLs a user navigates to independently. Getting Started should walk through the sidebar and step order.
- Some components exist in the repo but are dead code, not reachable in the UI: `StepFieldbuses.jsx`, `StepMRP.jsx`, `StepReconciliation.jsx`. These will not be documented as screens.
- The natural end-to-end workflow for a new user is roughly: Projects → Library (upload types) → HW Config (import hardware) → IO Import and/or EPH/EM Import → Hierarchy → Unit Types (if using S88 units) → Instances (map signals) → Generate. Getting Started will use a trimmed version of this as the "first meaningful action" path.
