# Projects

Projects are where all your work lives. Every import, hierarchy, and instance you create belongs to a project, and each project can contain multiple **user projects** — one per AS station — each of which produces its own XML file when you generate.

## Create a new project

1. Click **New project** in the top right.
2. Type a name (e.g. `Plant_A`).
3. Click **Create**.

The project becomes active immediately and appears in the Saved Projects list.

![Projects screen showing the saved projects list](/screenshots/projects-list.png)

## Load an existing project

Click anywhere on a project's row in the Saved Projects table to load it. The sidebar updates to show the active project name, along with a running summary of its library counts and instance count.

## Delete a project

Click the trash icon on the right of a project's row, then confirm. **This cannot be undone.**

## Add a user project

One XML file is generated per user project (e.g. `AS01.xml`, `AS02.xml`). To add one:

1. Under **User Projects**, click **Add user project**.
2. It's auto-named `AS01`, `AS02`, etc. — rename it inline if you'd like something more specific.

You can add as many user projects as your plant has AS stations. Remove one with the trash icon next to its name — if any instances still reference it, you'll be asked to confirm.

## Set up PCS7 project IDs

Each user project needs a set of PCS7 identifiers (Project Name/ID, Device Name/ID, CPU ID, Process Cell/ID, Unit Name/ID, CM Folder ID, Export User, Unit Author) before you can generate correct XML. There are two ways to fill these in:

- **Upload a PCS7 XML export** — click the upload icon next to a user project to open the config modal, then upload a SimaticML export. The fields auto-fill from the file.
- **Edit manually** — expand the PCS7 Project Config panel for a user project and type the values in directly, then click **Save**.

## Common issues

**A project I expected to see isn't in the list.**
Projects are shared across everyone using the app — there's no per-user filtering. If a project is missing, confirm you're looking at the right database/environment, or ask whoever last worked on it whether it was deleted.

**I can't tell which project is currently active.**
Check the sidebar — it always shows the current project name under **Project**, along with its library and instance counts. If it shows a dash, no project is loaded yet.
