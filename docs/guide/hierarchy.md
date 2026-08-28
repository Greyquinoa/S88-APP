# Hierarchy

The Hierarchy screen builds the ISA-S88 plant folder tree that your instances and hardware get filed under — think of it as the filing cabinet everything else gets organized into.

If you skip this step entirely, the app automatically falls back to a single ProcessCell folder for the whole project.

## Understand the tree

Each folder can optionally be tagged with an S88 type:

- **ProcessCell** — typically the top level, one per project
- **Unit** — a major process area or equipment group
- **EMOD** — an equipment module, nested under a unit
- **— plain —** — a folder with no specific S88 meaning, useful for organizational grouping (e.g. "CM", "NIF")

Instances are assigned to whichever folder makes sense for them on the [Instances](/guide/instances) screen.

## Build the tree

1. Click **+ Add root folder** to start a new top-level branch, or use the **+** icon next to any existing folder to add a child.
2. Type the folder's name.
3. Pick its S88 type from the dropdown, if applicable.
4. Keep nesting until you reach the folders instances will actually live in.

![Hierarchy tab with a multi-level plant tree and equipment descriptions](/screenshots/hierarchy-tree.png)

Click a folder's name field to rename it inline. Use the arrow icon to expand or collapse a branch.

## Delete a folder

Click the trash icon next to a folder. If any instances are currently assigned to that folder or one of its descendants, you'll be asked to confirm — deleting clears their folder assignment rather than deleting the instances themselves.

## Add unit descriptions

The right-hand **Equipments (Units)** panel lists every folder tagged as a Unit, with an editable description field for each — useful for documenting what a unit actually does.

## Common issues

**Generation says "Saving hierarchy… try again in a moment."**
The app hasn't finished writing your latest folder edit to the database yet. Wait a few seconds and try generating again.

**An instance's folder dropdown is empty or missing options.**
Only leaf folders (folders with no children) can hold instances. If a folder you expect to see isn't listed, check whether it still has child folders under it.

**I deleted a folder by accident along with everything under it.**
Folder deletion cascades to all descendant folders. There's no undo — you'll need to rebuild the branch manually. Instances that were assigned to it are not deleted, only unassigned.
