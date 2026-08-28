# Getting Started

PCS7 Matrix Generator has no login — open the app and you're in. Here's the fastest path from a blank slate to your first generated XML file.

## 1. Create a project

Go to **Projects** and click **New project**. Give it a name and click **Create** — it loads automatically.

Add at least one **user project** (e.g. `AS01`) underneath it. Each user project produces its own XML file later, so you need at least one before you can generate anything.

See: [Projects](/guide/projects)

## 2. Upload your CM/EM/EPH library

Go to **Library → Upload Library** and upload your `SIE_LIB.XML` file. This only needs to be done once — the library is shared across all projects.

See: [Library](/guide/library)

## 3. Bring in your plant data

Depending on what you're starting from:

- If you have a **plant IO/signal list** (Excel), use [IO Import](/guide/io-import) — upload it, map its columns, review the assignments, and promote it into instances.
- If you have a **Physical Model / equipment matrix**, use [EPH/EM Import](/guide/eph-em-import) instead.

Either path ends with real instances appearing in your project.

## 4. Organize your plant hierarchy (optional)

If you didn't build one automatically during import, use [Hierarchy](/guide/hierarchy) to create the folder structure your instances will be filed under. You can also skip this — the app falls back to one default folder.

## 5. Finish and generate

Go to [Instances](/guide/instances) and confirm every instance has a **User Project**, a **Controller**, and (if you built one) a **Folder**. Once they do, click **Generate XML**.

You'll land on [Generate](/guide/generate), where your XML files are ready to preview and download.

---

That's the shortest useful path through the app. For hardware-specific setup (stations, modules, MRP redundancy) see [HW Config](/guide/hw-config); for reusable unit templates see [Unit Types](/guide/unit-types).

If something doesn't work as expected, check the [Troubleshooting / FAQ](/troubleshooting) page next.
