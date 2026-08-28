# Troubleshooting / FAQ

## General

### Do I need to log in?

No. There's no login or user accounts anywhere in this app — anyone with access to it can see and edit everything. It's a single shared workspace, not a multi-tenant system. There's also no per-project ownership: any project one person creates, everyone can open and edit.

### How do I know my changes are saved?

Most edits (renaming, inline field changes) save automatically as you make them — you don't need to click a separate Save button in most places, though a few dialogs (Unit Types, Mode Commands) do have an explicit **Save** action. If something looks like it hasn't taken effect after a moment, refresh the page and check whether your change persisted.

### Can I undo a change?

No — there's no undo/redo in this app. If you need to revert something:

- Reload the page to discard any *unsaved* edits still in progress.
- For anything already saved (a deleted folder, a deleted instance), you'll need to manually recreate it — there's no built-in history or version control for project data.

### Can multiple people work on the same project at once?

Yes, but there's no real-time collaboration — if two people edit the same thing at the same time, the most recent save wins and the other person's change may be silently overwritten. For anything destructive (deleting instances, folders, or a whole project), coordinate with whoever else might be using it.

## Errors during setup

### "No library loaded"

You haven't uploaded a `SIE_LIB.XML` file yet. Go to [Library → Upload Library](/guide/library#upload-or-replace-the-library) and upload one — nothing else in the app works meaningfully without a library loaded.

### A tab I need is greyed out / disabled

Several screens (IO Import, EPH/EM Import) unlock their later tabs only once you've selected an uploaded file from an earlier tab. This selection can reset on a page reload — reselect your import and the tab should become clickable again.

### "Saving hierarchy… try again in a moment."

The app hasn't finished writing your latest hierarchy edit to the database. Wait a few seconds, then retry the action that triggered the message (usually Generate XML).

## Errors during import

### Some IO rows show "Unresolved" after import

The app couldn't automatically match a function code to a CM type. Go to [IO Import → Review](/guide/io-import#5-review-and-promote), filter by **Unresolved**, and manually assign a CM type to each flagged row.

### Promotion is blocked by a naming conflict

This happens in both [IO Import](/guide/io-import) and [EPH/EM Import](/guide/eph-em-import) when a row would create an instance whose name already exists in the project. A conflict resolution dialog appears — resolve each one (typically by renaming or skipping) before the import can complete.

### My composite/type mapping doesn't show the type I need

The type has to already exist in the [Library](/guide/library) — as a composite CM type for EPH/EM type mappings, or as a base CM type for IO function mappings. Create it in the Library first, then come back.

## Errors during instance setup and generation

### "Generate XML" is disabled and I can't tell why

The button requires **every** instance in the project — not just the ones visible on screen — to have a **User Project**, a **Controller**, and (if a hierarchy exists) a **Folder** assigned. Use the column filters in the [Instances](/guide/instances) grid to search each of those columns for blanks.

### An instance name is rejected as a duplicate

Instance names must be unique across the entire project, across CM, EM, and EPH types combined — not just within one type. Rename the new instance, or delete the old one if it's no longer needed.

### Two hardware modules show the same address

This is flagged as a conflict, usually surfaced during CFG generation or reconciliation. Open the conflicting stations/modules in [HW Config → Configuration](/guide/hw-config#configure-stations-and-slots) and change one of their addresses, then regenerate.

### A signal mapping shows a datatype warning

The hardware signal you're binding to a variable doesn't match its expected type (e.g. a digital signal bound to an analog input). Either pick a different signal, or proceed only if you're confident the mismatch is intentional for your hardware.

### The generated XML looks smaller than I expected

Check the per-file stats on the [Generate](/guide/generate) screen (block/variable counts) against your instance count. A shortfall usually means some instances weren't assigned to that particular user project, so they were excluded from that file.

## Network / connectivity

### The app seems frozen or an action never completes

This usually means the backend API isn't reachable. Check:

- That the backend service is actually running.
- Your network connection, if the app is hosted remotely rather than run locally.

Refreshing the page will show a clearer error if the backend is genuinely down, rather than the UI just waiting indefinitely.

### I got a red error banner — what do I do?

Read the message text first; most errors in this app describe exactly what's wrong (a missing field, a conflicting value, a failed save). Fix the specific issue named in the banner and retry the action — the banner usually clears on its own once the underlying problem is resolved.

## Still stuck?

There's no in-app support contact — if none of the above resolves it, reach out to whoever manages the app/database for your team.
