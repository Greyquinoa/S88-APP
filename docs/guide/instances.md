# Instances

This is the central working screen — the matrix/grid where you create, configure, and finalize every Control Module (CM), Equipment Module (EM), and Equipment Phase (EPH) instance in your project. Everything else in the app (Library, Hierarchy, IO Import) feeds into what you do here, and this is also where you trigger XML generation.

Instances are split across three sub-tabs: **CM**, **EM**, and **EPH**.

![Instances screen showing the CM grid](/screenshots/instances-cm-grid.png)

## Add an instance manually

1. Click **Add Instance**.
2. A blank row appears — fill in:
   - **Type** — the CM/EM/EPH type, from your [Library](/guide/library)
   - **Instance Name** — must be unique across the whole project
   - **Sample MS** — the sampling cycle time in milliseconds
   - **Controller (AS)** — which hardware controller owns this instance
   - **User Project** — which XML output this instance belongs to
   - **Folder** — where it sits in your [Hierarchy](/guide/hierarchy)

Edit any cell inline by clicking it.

## Add a batch from a composite

If you've defined a composite CM type in the Library:

1. Click **Add Composite**.
2. Pick the composite type.
3. Enter a base name.
4. Choose the user project, and optionally assign each member to a different folder.
5. Confirm to create the whole linked batch of instances at once.

## Map signals to hardware

Click **Map Signals** on an instance's row to open the mapping dialog, where you can:

- Bind each block's input/output variable to a hardware signal from the latest [HW Config](/guide/hw-config) import
- Edit static values directly
- View or override derived values
- Edit matrix-cell overrides (for CM types with a mode/command matrix)

The dialog also flags any datatype mismatches between a variable and the hardware signal you're binding it to.

## Reconcile against imported hardware

Rather than mapping every instance by hand, you can auto-match:

- **Generate Connections** (in the per-type toolbar) — auto-reconciles the whole project's dummy IOs against imported hardware signals.
- **Run Reconciliation** (top toolbar) — the same idea, with a summary view.
- **View Overview** — shows every instance's reconciliation status, with bulk **Accept** / **Revert to Dummy** actions and status filter chips.

Each instance also gets an **Accept** / **Revert to Dummy** action individually in the grid.

## Assign roles (EM/EPH only)

For EM or EPH instances, selecting a row opens a **Role** panel where you assign which CM/EM instances fill each named role the type requires (e.g. `BasePumpModule`).

## Preview and export

**View Exported Blocks** on an instance shows a preview of exactly what will be written into the generated XML for it — useful for double-checking a mapping before generating.

## Generate XML

Once every instance has a user project, a controller, and a folder (if a hierarchy is defined), the **Generate XML** button becomes active. Click it to move to the [Generate](/guide/generate) screen and produce your output files.

## Common issues

**Generate XML is disabled and I don't know why.**
It requires every single instance to have a User Project, a Controller, and (if you have a hierarchy) a Folder assigned — not just the ones you can currently see in the grid. Use the grid's column filters to search for blank values in the User Project, Controller, or Folder columns.

**An instance name is rejected as a duplicate.**
Instance names must be unique across the whole project, not just within CM/EM/EPH. Rename the new one, or delete the old one if it's no longer needed.

**Map Signals shows a datatype warning.**
The hardware signal you're binding doesn't match the variable's expected type (e.g. binding a digital signal to an analog input). Pick a different signal, or confirm the mismatch is intentional if your hardware genuinely differs from the type default.
