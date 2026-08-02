# User Guide — S88 App

## What is this app?

This application helps you create automation control configurations for Siemens PCS7 systems. It takes templates (called CM types), control lists (IO imports), and hardware layouts, then automatically generates the XML configuration files your system needs.

Think of it as an assembly line: you supply the building blocks, describe how they're organized, and the app generates the complete blueprint.

**Who should use this?** Anyone configuring Siemens PCS7 automation systems — control engineers, automation specialists, and system integrators.

---

## Getting Started

### Logging in / Starting the app

The app opens in your web browser. No login is required — your work is automatically saved to the database.

### First time?

Start at **Step 1: Projects**. Every piece of work you do lives in a project. Create a new project, give it a name (like "Plant_A" or "Process_Cell_001"), and you're ready to go.

Your changes save automatically as you work — you'll see status messages when data is being saved.

---

## The 8 Steps (in order)

The app guides you through 8 sequential steps, shown as numbered tabs at the top. You can jump between steps once you've created a project. Most users follow the steps in order.

---

### **Step 1: Projects**

**What it does:** Create, open, or manage projects.

#### Create a new project
1. Click the **New project** button (top right)
2. Type a project name (e.g., "Plant_A")
3. Click **Create**
   - The name becomes active immediately
   - It's now saved in the database

#### Define user projects
User projects are the individual automation systems your configuration will control. Typically named AS01, AS02, etc.

1. Under "User projects," click **Add user project**
2. Name it (e.g., "AS01")
3. Add more as needed
   - Each gets its own XML output file at the end (AS01.xml, AS02.xml, etc.)
   - You can edit or delete names anytime

#### Load an existing project
1. Look in the "Saved projects" list
2. Click on any project row to open it
3. Once loaded, the project name appears in the active section

#### Delete a project
- Click the trash icon on the right side of any project row
- Confirm the deletion (this cannot be undone)

#### PCS7 Project IDs (optional)
If you have a PCS7 SimaticML export file, you can upload it to pre-fill hardware IDs:

1. Scroll to "PCS7 Project Config" at the bottom
2. Click to expand the section
3. Click **Upload PCS7 XML**
4. Choose your SimaticML file
5. Fields auto-fill; you can edit them manually if needed

---

### **Step 2: IO Import**

**What it does:** Upload lists of Input/Output signals and set up how they map to your configuration.

This step is for the detailed control signals your system needs to read and write. It's often the biggest data load in the workflow.

#### Upload an IO list

1. Go to the **Upload** tab
2. Drag an Excel file onto the upload box, or click to browse
3. Select a sheet from the file (if it has multiple)
4. Choose a **Column Map** if you've saved one before (optional)
5. Click **Start upload**

The system will preview the data and display a status.

#### What happens next?

Once uploaded, the other tabs unlock:
- **Function Mapping** — maps equipment functions (like "XV" for a valve) to CM types (like "CCM_Valve"), so the system knows which instances to create
- **Column Mapping** — tells the system which columns in your file contain what (e.g., "column A is the signal name")
- **Hierarchy** — optionally organizes signals into groups
- **Review** — shows all signals and their status
- **Auto Workflow** — automatically processes the entire import with one click

#### Manage imports

The "Upload" tab shows all imports you've created:
- Click one to view its details
- Click the trash icon to delete it
- Only one import can be active at a time

#### Import to Hardware

If you need to use this IO data to build a hardware configuration:

1. After uploading, click the **Import Hardware** button
2. The system copies the IO list to your Hardware Config (Step 6)
3. You're sent to the Hardware Config tab to complete the mapping

---

### **Step 3: Library**

**What it does:** Upload and manage CM types (control modules), which are the building blocks of your configuration.

A CM type is a reusable piece of control logic. Once uploaded, you use it to create instances (actual copies) in your project.

#### Upload a library (SIE_LIB.XML)

1. Go to the **Upload Library** tab
2. Drag your SIE_LIB.XML file onto the upload box, or click to browse
3. The system reads and stores it (you only need to do this once; the library is persistent in the database)

A green banner shows "✓ Library loaded — N CM/EM/EPH types" when ready.

#### Manage CM type blocks

A CM type contains optional and required blocks (sub-components).

1. Go to the **Type Configuration** tab
2. See all loaded CM types on the left
3. Click a CM type to see its details
4. Toggle optional blocks on/off:
   - Green blocks are always on (required)
   - Blue blocks are optional — click the checkbox to enable/disable them
5. Changes save automatically

#### Block details

The three sub-sections show:
- **Blocks** — which sub-components are enabled
- **Inputs** — input signals (things the CM receives from elsewhere)
- **Outputs** — output signals (things the CM sends to the rest of the system)

You can also edit default values and validation rules here.

#### Composite CM types

A composite CM is a pre-configured bundle of multiple CMs that work together (e.g., a pump with a motor and a sensor).

1. Go to the **Composite CM Types** tab
2. Click **New** to create one, or select an existing one to edit
3. Define:
   - The base member (primary CM)
   - Additional members (secondary CMs)
   - How they wire together (interconnections)
   - Optional: folder hierarchy rules (where each member goes when added)
4. Click **Create composite** to save

Composites are helpful for keeping related equipment together.

#### Mode commands (valve commands)

If your system uses valve modes or similar commands:

1. Go to the **Mode Commands** tab
2. Manage the lookup table of mode names and their values
3. Add, edit, or delete as needed

---

### **Step 4: Unit Types**

**What it does:** Create reusable unit templates that encapsulate logic (like an operator override or a safety interlock).

Unit types are optional — use them when you want to save a specific configuration of instances and connections as a template.

#### Create a unit type

1. Click **New unit type**
2. Give it a name (e.g., "MotorUnit" or "PumpInterlockUnit")
3. Add one or more CM instances to it
4. Define how they connect to each other
5. Save

#### Define connections

Connections wire the inputs and outputs of CMs together:

1. Select an instance in the "Instances" table
2. In the "Connections" section, click **Add connection**
3. Choose:
   - Source: which CM and which output
   - Destination: which other CM and which input
4. Click **Add** to save the wire
5. Click **Save unit type** when done

#### Use a unit type

When you've created a unit type, you can expand it into actual instances in your project:

1. Go to Step 5 (Instances)
2. Click **Expand unit types** (if available)
3. The system creates individual instances from your saved unit types

---

### **Step 5: Hierarchy**

**What it does:** Build the plant structure (the ISA S88 tree) that organizes all your control logic.

Think of this as the filing system: ProcessCell contains Units, which contain Equipment, which contain PhaseActions.

#### Understand the hierarchy

The hierarchy is a tree:
- **ProcessCell** (top level) — usually one per project
- **Unit** — a major equipment area or process step
- **Equipment** — individual devices or groups (pumps, motors, tanks)
- **EMOD** — equipment module, a sub-component

Leaf folders (folders with no children) is where you'll place actual control instances in the next step.

#### Add a root folder

1. Click **Add root folder**
2. Name it (e.g., "ProcessCell_A")
3. Pick an optional S88 type from the dropdown (ProcessCell, Unit, Equipment, EMOD, or plain)

#### Add subfolders (nested levels)

1. Click the **+** button next to a folder to add a child
2. Type a folder name
3. Assign an S88 type if needed
4. Keep nesting until you have leaf folders at the bottom

#### Edit or delete

- Click a folder name to edit it
- Click the **trash icon** to delete it
- If instances are assigned to a folder you delete, you'll be asked to confirm

#### Leave empty for default

If you don't add any hierarchy, the system automatically creates a single ProcessCell for you.

---

### **Step 6: Instances**

**What it does:** Create individual copies of CM types, assign them to folders, and connect them to the hardware/IO.

Instances are the actual control logic running in your plant.

#### Add instances manually

1. Click **Add instance**
2. A row appears. Fill in:
   - **CM Type** — pick from the dropdown (loaded from library)
   - **Instance Name** — a unique name (e.g., "PUMP_CONTROLLER_01")
   - **Sampling Time** — cycle time in milliseconds (usually 1000)
   - **User Project** — which system owns this instance (pick one of your user projects)
   - **Folder** — which hierarchy folder contains it (pick a leaf folder)

#### View and manage instances

The grid shows all instances. You can:
- **Edit inline** — click any cell to edit
- **Delete** — click the trash icon
- **Filter by type** — see only ControlModule, EquipmentModule, or EquipmentPhase instances

#### Add composite instances

If you've created composite CM types:

1. Click **Add composite**
2. Pick the composite type
3. Enter a base name (the primary instance name)
4. Optionally, assign each member to a different folder
5. Click **Add instances**

The system creates one instance per composite member with linked connections.

#### Connections (IO mapping)

If you've imported IO signals, each instance may have a "Connections" column showing how many signals are mapped:

- Green badge: all signals mapped to hardware
- Amber badge: some mapped, some pending
- Orange badge: no mappings yet

Click **Generate Connections** to automatically match dummy IO signals to real hardware.

#### Role assignment (for EM/EPH)

If an instance is an EquipmentModule or EquipmentPhase, you can assign roles:

1. Click the instance row to select it
2. In the "Roles" section, assign which other instances play which roles
3. Common roles: BasePumpModule, BaseMotorModule, etc.

---

### **Step 7: HW Config**

**What it does:** Set up hardware configuration — stations, modules, and IP addresses.

This step is for detailed hardware-level settings and is mostly optional unless you're using advanced hardware import features.

**Note:** Some features in this step are only available in the local version of the app (MRP Topology, Controllers, Fieldbuses). The online version focuses on the core Import and hardware station/module management.

#### Import hardware baseline

1. Go to the **Import** tab
2. Upload a CFG (configuration) file from your PCS7 system
3. The system reads and displays the hardware tree

#### Hardware station and module management

1. View stations, slots, and modules in the main grid
2. Click **Add station** to create a new hardware station
3. Enter address, name, and IP address
4. Add modules to slots
5. Bulk operations available: approve, delete, or copy stations

#### MRP topology view (local version only)

In the local version of the app, you can see the hardware tree structure visually:

1. Go to the **MRP Topology** tab
2. View all stations, controllers, and modules
3. Inline-edit stations and slots as needed

*(This tab is not available in the online version.)*

#### Add stations and modules

1. Click **Add station**
2. Enter address, name, IP, and other details
3. Click **Add module**
4. Assign modules to slots

#### Module templates and catalogue

If you're using equipment templates:

1. Go to the **Catalogue** tab
2. Manage module templates (reusable module definitions)
3. Use them to quickly populate hardware slots

#### Controllers & Fieldbus configuration (local version only)

In the local version, additional tabs exist:

- **Controllers** — Configure SIMATIC controllers, serial numbers, firmware versions
- **Fieldbuses** — Set up fieldbus networks (PROFINET, Modbus, etc.)

*(These tabs are not available in the online version.)*

---

### **Step 8: Generate**

**What it does:** Create the final XML configuration files.

#### Start generation

1. Go to Step 5 (Instances) to review your data
2. Click **Generate XML**
3. A progress bar appears at the top, updating in real time
4. The system generates one XML file per user project

#### View results

Once generation completes:

1. You're taken to Step 8 (Generate)
2. The results show:
   - **File names** (AS01.xml, AS02.xml, etc.)
   - **Download links** — click to download each file
   - **Statistics** — number of instances, blocks, variables, etc.
   - **Audit details** — technical info and any warnings

#### Download files

Each XML file is ready to upload to your PCS7 system. Click the file name to download.

#### Troubleshooting generation

If generation fails:

- Check the error message (red banner at the top)
- Make sure all instances are assigned to a user project
- Make sure all folders are properly saved (check for pending DB saves)
- If you see a conflict error (duplicate addresses), review the details and fix overlaps

---

## Features and Tips

### Auto-save

All your work saves automatically as you type. You'll see a brief status message when saving happens. You never need to click "Save" — the app handles it.

### Search and filter

In grids with many rows:
- Use the search box to filter by name
- Click column headers to sort
- Use dropdowns to filter by type

### Drag and drop

For file uploads:
- Drag files onto the upload box instead of clicking if you prefer
- Works for library files, IO imports, and hardware configs

### Keyboard shortcuts

- **Enter** — confirm a dialog or input
- **Escape** — close a dialog or cancel an edit
- **Tab** — move between fields

### Validators and error messages

The app checks your data as you go. If you see a red error message:
- Read the message carefully — it tells you what's missing or wrong
- Fix the issue and the error usually clears automatically
- Some errors (like duplicate names) appear in a table below the message showing exactly which rows conflict

### Exporting vs. generating

- **Export** in the IO Import step downloads the processed IO list as a file (for review or use elsewhere)
- **Generate** in the final step creates your PCS7 configuration XML

---

## Troubleshooting and FAQ

### "Saving hierarchy… try again in a moment."

The app detects that your folder hierarchy hasn't finished saving to the database yet. Wait a few seconds and click Generate again. This usually happens after adding new folders.

### "Every instance must be assigned to a user project"

Check the "User Project" column in the Instances grid. Some instances have a blank value. Either:
- Select a user project for each instance
- Or delete instances you don't need

### Why does the app show "No library loaded"?

You haven't uploaded the SIE_LIB.XML file yet. Go to Step 3 (Library) → Upload Library tab and upload the file.

### I want to change an instance name, but it says the name is taken.

Instance names must be unique. Try:
- Renaming the existing one first
- Or deleting the old one if you don't need it

### How do I undo a change?

The app doesn't have an undo button. Instead:
- Reload the page (Ctrl+R or Cmd+R) to discard unsaved changes
- Or manually revert the field to its previous value

If you deleted a project or major data, contact your administrator — the database keeps backups.

### My IO import shows "unresolved" signals.

This means the system couldn't automatically match the signal to a function. Go to the **Review** tab in IO Import and manually assign the function to those signals.

### Can I work on multiple projects at once?

Yes. Go to Step 1 (Projects) and click a different project to switch. Each project keeps its own state. The app remembers which project you were working on.

### What if my hardware has two modules with the same address?

The system flags this as an error and shows which stations/modules conflict. Edit the address of one of them in the Hardware Config tab, then regenerate.

---

## Advanced Features (Specialized)

The following features are implemented in the code but require specialized knowledge and are not covered step-by-step in this guide:

### For Power Users:

- **MRP Topology View** — Advanced view of multi-device resource planning (Step 6, MRP Topology tab). Shows complex hardware relationships.
- **Signal Mapping Modal** — Deep per-instance variable binding to hardware signals (click "Map signals" in Instances grid). Allows datatype validation and static/derived value overrides.
- **Unit Type Connections** — Wiring logic between Unit Type members (different from instance connections). Define how member units communicate.
- **Derived Values** — Data columns from IO list mapped to CM variables at runtime (set in signal mapping).
- **Matrix Mode Overrides** — Per-instance customization of matrix cell values for matrix-mode CM types.
- **Block Preferences** — Persistent per-CM-type storage of which optional blocks are enabled across projects.
- **Slot Compatibility Rules** — Define which subslot order numbers can fit into which slot order numbers in hardware.
- **Module Templates** — Reusable hardware module definitions with compatibility matrices.
- **Hardware Resolution CSV** — Import/export hardware-to-IO signal mapping as CSV for bulk operations.

### For System Integrators:

- **CFG File Generation** — Export hardware configuration back to PCS7 format (Step 6).
- **Audit Trail** — Full history of XML generations with statistics and diagnostics.
- **Bulk Hardware Operations** — Approve, delete, or copy multiple stations at once.
- **Auto Column Mapping** — System suggests which Excel columns map to which fields based on header analysis.
- **Datatype Validation** — Signal mapping checks that signal types match variable input/output types (DI→bool, AI→real/word/int, etc.).
- **Reconciliation Report** — View how many dummy IO signals are bound to real hardware per instance.

If you need to use any of these, consult your system administrator or refer to the backend documentation.

---

## Known Limitations and Incomplete Features

### Limitations:

- **Hardware import requires baseline** — The system needs a pre-existing CFG or hardware structure to import IO signals; it won't auto-create empty hardware from an IO list alone.
- **Composite CM auto-wiring is manual** — You must define interconnections between composite members; some auto-detection is not yet implemented.
- **Single-user projects** — Only one person can edit a project at a time; there's no real-time collaboration or live sync between users.
- **Large IO imports untested** — Performance with very large imports (10,000+ signals) has not been extensively tested.
- **No version control** — Projects don't have branching, merging, or rollback; changes overwrite the previous version.
- **Dark mode incomplete** — Dark theme exists but is not fully polished in all screens.

### Not Yet in the App:

- Batch import of multiple projects
- Role-based access control (all users have full access to all features)
- Git-style version control / branching
- Direct PCS7 system upload (you must download XML and upload manually to PCS7)
- Undo/redo functionality

---

## Support

If you encounter an issue or need clarification:

1. **Check this guide** — search for your question above
2. **Check the error message** — most errors are self-explanatory
3. **Reload the page** — sometimes a refresh fixes transient issues
4. **Contact your system administrator** — they can help with database issues or access problems

---

## Summary

The workflow is:

1. **Create a project** → define user projects
2. **Import IO signals** (if using hardware)
3. **Upload CM library** → configure which blocks to use
4. **Define hierarchy** → build your plant structure
5. **Add instances** → create copies of CM types, assign to folders
6. **(Optional) Configure hardware** → hardware setup
7. **Generate XML** → create the final configuration files
8. **Download and deploy** → upload to your PCS7 system

Most projects take 1–2 hours from start to download. Larger or more complex systems may take longer due to detailed IO mapping and hardware setup.

Good luck with your configuration!
