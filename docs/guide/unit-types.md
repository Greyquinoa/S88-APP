# Unit Types

Unit Types are reusable S88 unit templates. Instead of building the same combination of composite CM types over and over, define it once as a Unit Type, then create as many Unit Instances of it as you need — one per physical unit in your plant.

This screen is optional. If your plant doesn't use repeating unit templates, you can skip straight to building [Instances](/guide/instances) directly.

There are two sub-tabs: **Unit Configuration** and **Unit Instances**.

## Define a unit type

1. Go to **Unit Configuration**.
2. Click **Import from PCS7** to bring one in from an existing PCS7 export, or click **+** to create a new one from scratch.
3. Give it a name and description.
4. Click **Add Member** for each composite CM type the unit should contain — give each member an alias (e.g. `XV10`, `UNIT_PLC`).
5. Expand a member's row to assign EM/EPH roles if needed.
6. Under **Unit Level Connections**, wire members together (interconnections or static values).
7. Click **View Spirograph** for a visual diagram of how members connect.
8. Click **Save Unit Type**.

![Unit Configuration tab showing a unit type with members and connections](/screenshots/unit-types-configuration.png)

## Create unit instances

Once a unit type exists, use **Unit Instances** to create concrete copies of it in your project.

1. Go to **Unit Instances**.
2. Click **Add Unit Instance**.
3. Pick the unit type, give the instance a name, choose its parent hierarchy path, and assign it to a user project.
4. Repeat for each physical unit you need.

![Unit Instances tab](/screenshots/unit-types-instances.png)

Instance fields (name, parent path, user project) save automatically as you edit them inline.

## Expand instances into real CM/EM/EPH instances

Unit Instances are templates until you expand them. Click **Generate Instances** to turn each Unit Instance into its actual set of CM/EM/EPH instances on the [Instances](/guide/instances) screen. If any resulting instance name would conflict with one that already exists, you'll be asked to resolve the conflict first.

## Common issues

**A composite type I need isn't in the dropdown.**
Composite CM types are defined in [Library → Composite CM Types](/guide/library#build-composite-cm-types). Create it there first.

**Generate Instances didn't create anything.**
Check that the Unit Instance has a unit type, name, and user project assigned — incomplete Unit Instances are skipped.

**Two units ended up with clashing instance names.**
This is exactly what the conflict-resolution dialog during expansion is for — if you skipped past it, delete the conflicting instances and re-run Generate Instances, resolving each conflict this time.
