# EPH/EM Import

This is a separate import pipeline from [IO Import](/guide/io-import), used for **Equipment Phase (EPH)** and **Equipment Module (EM)** rows rather than Control Module IO rows. Use it when your source data describes units and their equipment types (e.g. a Physical Model matrix) instead of individual signals.

The screen has three visible sub-tabs: **Type Mappings**, **Upload**, and **Review**.

## 1. Define type mappings

Before uploading, set up how values in your Excel file map to composite CM types.

1. Go to **Type Mappings**.
2. Create a new config, or select an existing one.
3. For each Excel column value you expect (e.g. a type code), map it to the composite CM type it should instantiate, with a match mode and priority.

![Type Mappings tab](/screenshots/eph-em-type-mappings.png)

Save this as a named config so you can reuse it across uploads.

## 2. Upload your file

1. Go to **Upload**.
2. Click **+ Upload EPH/EM List**, or drag your file onto the panel.
3. Choose which column identifies the unit, and select the type-mapping config to apply.

![Upload tab with a stored EPH/EM import](/screenshots/eph-em-upload.png)

Previously uploaded imports are listed under **Stored Imports** — click one to select it as active.

## 3. Review and promote

1. Go to **Review**.
2. Check each row's proposed assignment; patch or reject individual rows as needed.
3. Run auto-assignment if you haven't already.
4. If the app detects a naming conflict with an existing instance, a conflict resolution dialog appears — resolve each conflict before continuing.
5. Click **Promote** to create the resulting Unit Instances in your project.

![Review tab for an EPH/EM import](/screenshots/eph-em-review.png)

## Common issues

**Review is greyed out.**
You need to select a stored import from the Upload tab first — the tab unlocks once an import is active.

**Promotion is blocked by a naming conflict.**
This means a row would create an instance with a name that already exists. Resolve each conflict in the dialog that appears (typically by renaming or skipping the conflicting row) before promotion can continue.

**I don't see the type I need in Type Mappings.**
Make sure the type exists in your [Library](/guide/library) first — as a composite CM type. Type Mappings can only point to composites that are already defined.
