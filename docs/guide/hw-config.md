# HW Config

This screen manages PLC hardware configuration — stations, racks, slots and modules, IP addresses, MRP redundancy, and the module template catalogue. It's organized as a left-hand navigation (Import / Catalogue / a list of Controllers), with each controller having its own Controller / Configuration / MRP sub-tabs.

## Import a hardware baseline

1. Go to **Import**.
2. Upload a baseline `.CFG` file from your PCS7 system, or an IO-list Excel file.
3. Use **Backfill from CFG** if you need to re-derive mappings from an existing CFG.
4. If prompted, map the IO-list columns — the app suggests matches automatically, but you can override any of them.
5. Review the staged rows before applying them.

![HW Config Import tab](/screenshots/hw-config-import.png)

::: tip
Hardware import needs a baseline to work from — the app can't create hardware structure from an IO list alone.
:::

## Manage the module catalogue

The **Catalogue** tab holds reusable hardware module templates — the definitions used to populate slots quickly.

![Catalogue tab showing module templates](/screenshots/hw-config-catalogue.png)

- Add or edit a template directly, including its signal types and slot/subslot compatibility rules.
- Click **Import from .cfg** to bulk-add or update templates by parsing an existing `.cfg` file.
- Delete a template with the trash icon — if it's currently in use, you'll be asked to confirm.

## Configure a controller

Select a controller from the left-hand list, then use its **Controller** tab to:

- Edit its name and station type (S7-400, S7-300, WinAC, etc.)
- Add, edit, or delete its fieldbuses
- Delete the controller entirely (this cascades to its imports, signals, configs, and fieldbuses)

## Configure stations and slots

Under a controller's **Configuration** tab:

1. Click **Add station**, pick a device type/interface module template, and fill in its name and IP address.
2. Add slots/modules to the station.
3. Edit slot channel parameters, potential group, PIP mapping, PA profile, and subslot profile as needed.
4. Use bulk-select to approve or delete multiple stations at once, or **Copy** a station to reuse its setup.
5. For ET200SP-style stations, use the auto-slot editor to configure slots quickly.

Click **Symbol Table** to see every configured signal across the station in one place.

## Generate and download CFG

From the Configuration tab, use **Generate CFG** (with options for All / Selected / Approved stations only), then **Download CFG**. The download includes summary stats — station, module, and signal counts.

## Configure MRP (redundancy)

Under a controller's **MRP** tab:

1. Assign device roles in the ring.
2. Draw or edit port links using the canvas view, or fill them in via a form.
3. Set the domain name and fieldbus.
4. Click **Save**, then **Download** to get the MRP-augmented CFG.

Device node positions on the canvas are remembered locally in your browser.

## Common issues

**A catalogue template won't delete.**
If it's currently used by a station or slot, the app blocks deletion and shows a usage-check confirmation — remove or reassign those usages first.

**My IO addresses don't match what I expected.**
Address allocation happens per controller, using a sequential packing strategy from a cursor-based baseline. If addresses look off, check that the correct baseline CFG was imported for that controller.

**Two modules show the same address.**
This is flagged as a conflict during generation. Open the conflicting stations/modules in Configuration and change one of their addresses, then regenerate.
