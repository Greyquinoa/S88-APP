# IO Import

Upload your plant's Control Module IO/signal list (an Excel file) here, map it to the fields the app understands, and promote it into real instances in your project.

The screen has six sub-tabs: **Function Mapping**, **Upload**, **Column Mapping**, **Hierarchy**, **Review**, and **Auto Workflow**. Most of these stay locked until you've uploaded and selected a file.

## 1. Upload your IO list

1. Go to the **Upload** tab.
2. Click **+ Upload IO List**, or drag your Excel file onto the panel.
3. If the file has multiple sheets, pick the one to import.
4. Optionally choose a saved **Column Map** preset to auto-apply your usual field mapping.

Uploaded imports are listed on the left. Click one to select it as the active import — the other tabs unlock once one is selected.

![IO Import upload screen with two stored imports](/screenshots/io-import-upload.png)

**Reimport** (the refresh icon) lets you replace the file behind an existing import while keeping its saved column mappings. **Delete** (the trash icon) removes an import entirely.

## 2. Set up function mapping (optional but recommended)

The **Function Mapping** tab lets you define reusable rules like "function code XV → CM type CCM_VALVE," so the app can automatically suggest a CM type for each row later. Save a named preset here once, and reuse it on every future import.

![Function Mapping tab](/screenshots/io-import-function-mapping.png)

## 3. Map your columns

Once an import is selected, go to **Column Mapping** to tell the app which Excel column holds which field — tag name, description, signal type, CM type, AS assignment, and so on.

![Column Mapping tab](/screenshots/io-import-column-mapping.png)

You can save this mapping as a named preset so you don't have to redo it for similar files in the future.

## 4. Build the hierarchy (optional)

The **Hierarchy** tab can auto-build a folder structure from your tag naming convention. If you skip this, everything falls back into a single default ProcessCell folder — you can also build the hierarchy manually later on the [Hierarchy](/guide/hierarchy) screen.

![Hierarchy tab showing the generated plant tree](/screenshots/io-import-hierarchy.png)

## 5. Review and promote

The **Review** tab is where you check the app's work before committing it to your project.

![Review tab with per-row tag assignments](/screenshots/io-import-review.png)

- Each row shows the tag, its assigned CM type, its resolved hierarchy path, and its status.
- Use the filter chips (**All / Auto / Approved / Manual / Unresolved**) to narrow the list.
- Edit a row's assigned type directly in its dropdown if the automatic guess is wrong.
- Click **Approve all auto** to accept every automatically-assigned row at once.
- Click **Promote to project** when you're happy with the review — this creates the actual instances in your project.

## 6. Or, run it all at once

The **Auto Workflow** tab runs upload → column mapping → type assignment → promotion as a single one-click pipeline, useful once you already have a known-good column map and function mapping saved from a previous import.

![Auto Workflow tab](/screenshots/io-import-auto-workflow.png)

## Sending IO data to hardware configuration

If your IO list also needs to drive hardware setup, use **Import Hardware** after uploading (once the AS-assignment column is mapped). This splits the rows by controller and sends them to the [HW Config](/guide/hw-config) screen for hardware ingestion.

## Common issues

**Some rows show "Unresolved" in Review.**
The app couldn't automatically match a function code to a CM type. Go to the Review tab, filter by **Unresolved**, and manually assign a CM type to each of those rows.

**A tab I need is greyed out.**
Column Mapping, Hierarchy, Review, and Auto Workflow are disabled until you've selected an uploaded import from the Upload tab's list — a fresh page load resets this selection, so you may need to click your import again.

**I uploaded the wrong file.**
Use **Reimport** to replace the file on the existing import (keeps your column mapping), or delete the import and start over.
