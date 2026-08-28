# Generate

This is the final step — view and download the PCS7 XML files produced from your project.

## Generate your output

XML generation is triggered from the [Instances](/guide/instances) screen, not from here — click **Generate XML** there once every instance has a user project, controller, and folder assigned. You're automatically brought to this screen when generation completes.

## View and download results

Once generation finishes, this screen lists one file per user project.

![Generate screen showing three completed XML files](/screenshots/generate-output.png)

For each file you can:

- **Expand** it to preview the first 150 lines
- **Copy** its contents to the clipboard
- **Download** it individually

If more than one file was generated, **Download all** grabs every file at once.

Each file's row also shows quick stats — block count, variable count, message count, and file size — so you can sanity-check the output before downloading.

## Start over

Click **Back** to return to the Instances screen if you need to make changes and regenerate.

## Common issues

**The screen says "No XML generated yet."**
Nothing has been generated for this project. Go to [Instances](/guide/instances) and click **Generate XML** — if that button is disabled, see the Instances page's troubleshooting section for what's blocking it.

**A generated file looks smaller/larger than expected.**
Check the per-file stats (blocks, vars, size) against what you'd expect given your instance count — a big mismatch usually means some instances weren't included, often because they weren't assigned to that particular user project.

**I need the previous version of a file I already regenerated.**
This app doesn't keep a version history of generated output — each generation replaces the previous result. If you need the old file, you'll need to have downloaded it beforehand.
