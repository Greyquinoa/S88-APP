# Library

The Library is the master catalog of Control Module (CM), Equipment Module (EM), and Equipment Phase (EPH) types your project can use. It's loaded from a Siemens `SIE_LIB.XML` export and shared across all projects.

There are five sub-tabs: **Upload Library**, **Type Configuration**, **Composite CM Types**, **Mode Commands**, and **Audit Log**.

## Upload or replace the library

1. Go to **Upload Library**.
2. Drag `SIE_LIB.XML` onto the panel, or click to browse.
3. Once loaded, you'll see a confirmation with the CM/EM/EPH counts and the last-updated timestamp.

![Upload Library tab showing a loaded library](/screenshots/library-upload.png)

Uploading again replaces the current library. This only needs to be done once — the library persists in the database and is shared by every project.

## Configure types

**Type Configuration** lets you search and inspect every CM/EM/EPH type in the library.

1. Filter by type (All / CMT / EMT / EPH) and search by name.
2. Select a type to see its **Blocks**, **Inputs**, and **Outputs**.
3. In **Blocks**, toggle optional blocks on or off — required blocks can't be disabled, and a block can also be marked "conditional."
4. In **Inputs**/**Outputs**, edit a variable's default value, or toggle whether it's usable in mappings.
5. Use the trash icon to remove a type from the library entirely.

![Type Configuration tab](/screenshots/library-type-configuration.png)

Changes here save automatically.

## Build composite CM types

A composite groups several CM types together into one reusable template — useful for equipment made of multiple linked modules (e.g. a valve with its NIF companion block).

1. Go to **Composite CM Types**.
2. Create a new composite, or select an existing one.
3. Add, remove, or reorder its members.
4. Wire connections between members (interconnections, or static/derived values).
5. If the composite needs a valve-command matrix, configure its columns and mode rows.
6. Set up per-member IO-connection rules so members auto-wire to hardware inputs.

![Composite CM Types tab](/screenshots/library-composite-cm-types.png)

Composites you create here are used throughout the app — in [Unit Types](/guide/unit-types), [EPH/EM Import](/guide/eph-em-import) type mappings, and [Instances](/guide/instances) via **Add Composite**.

## Manage mode commands

**Mode Commands** holds the named-command-to-integer lookup table used in matrix cell dropdowns (e.g. valve command matrices).

![Mode Commands tab](/screenshots/library-mode-commands.png)

Click **Edit** to add, remove, or rename rows, then **Save**.

## Review the audit log

**Audit Log** shows every create/update/delete change made to the library, with before/after field values.

![Audit Log tab](/screenshots/library-audit-log.png)

Filter by action type, user, or date range to find a specific change.

## Common issues

**The sidebar shows "No library loaded."**
Go to Upload Library and upload your `SIE_LIB.XML` file — nothing else in the app works until a library exists.

**A CM type I need is missing after a re-upload.**
Re-uploading replaces the whole library. If a type existed before and doesn't appear in your new file, it will no longer be available — check the Audit Log to confirm what changed.

**I can't tell why a block won't toggle off.**
Required blocks are always on and can't be disabled — only blocks marked optional in Type Configuration can be toggled.
