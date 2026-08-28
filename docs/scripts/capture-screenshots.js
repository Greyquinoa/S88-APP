// Captures screenshots of every screen/sub-tab in the PCS7 Matrix Generator app
// for use in the VitePress user manual (docs/public/screenshots/).
//
// Requirements before running:
//   - Backend running on http://localhost:3001
//   - Frontend dev server running on http://localhost:5174 (adjust APP_URL below if different)
//   - At least one project in the database with sample data (IO import, hierarchy,
//     instances, hardware config) so screens aren't captured in an empty first-run state
//
// Usage: node scripts/capture-screenshots.js

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL || 'http://localhost:5174';
const PROJECT_NAME = process.env.DOCS_PROJECT_NAME || 'rIX';
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

// Each entry: [step label in sidebar, output file slug, optional sub-tab label, optional "before" hook name]
const SHOTS = [
  ['Projects', 'projects-list', null, null],

  ['IO Import', 'io-import-upload', 'Upload', null],
  ['IO Import', 'io-import-function-mapping', 'Function Mapping', null],
  ['IO Import', 'io-import-column-mapping', 'Column Mapping', 'selectFirstIoImport'],
  ['IO Import', 'io-import-hierarchy', 'Hierarchy', null],
  ['IO Import', 'io-import-review', 'Review', null],
  ['IO Import', 'io-import-auto-workflow', 'Auto Workflow', null],

  ['EPH/EM Import', 'eph-em-type-mappings', 'Type Mappings', null],
  ['EPH/EM Import', 'eph-em-upload', 'Upload', null],
  ['EPH/EM Import', 'eph-em-review', 'Review', 'selectFirstEphEmImport'],

  ['Library', 'library-upload', 'Upload Library', null],
  ['Library', 'library-type-configuration', 'Type Configuration', null],
  ['Library', 'library-composite-cm-types', 'Composite CM Types', null],
  ['Library', 'library-mode-commands', 'Mode Commands', null],
  ['Library', 'library-audit-log', 'Audit Log', null],

  ['Unit Types', 'unit-types-configuration', 'Unit Configuration', null],
  ['Unit Types', 'unit-types-instances', 'Unit Instances', null],

  ['Hierarchy', 'hierarchy-tree', null, null],

  ['Instances', 'instances-cm-grid', null, null],

  ['HW Config', 'hw-config-import', 'Import', null],
  ['HW Config', 'hw-config-catalogue', 'Catalogue', null],

  ['Generate', 'generate-output', null, 'generateXmlIfNeeded'],
];

const BEFORE_HOOKS = {
  async selectFirstIoImport(page) {
    // The Column Mapping / Hierarchy / Review / Auto Workflow tabs are disabled until
    // an uploaded IO import is selected from the list, which lives on the Upload tab.
    await page.locator('.app-content').getByText('Upload', { exact: true }).first().click();
    await page.waitForTimeout(500);
    const firstImportRow = page.locator('.app-content').locator('text=Sample_').first();
    if (await firstImportRow.isVisible().catch(() => false)) {
      await firstImportRow.click();
      await page.waitForTimeout(600);
    }
  },
  async selectFirstEphEmImport(page) {
    // Review is disabled until a stored EPH/EM import is selected, from the Upload tab.
    await page.locator('.app-content').getByText('Upload', { exact: true }).first().click();
    await page.waitForTimeout(500);
    const firstImportRow = page.locator('.app-content').locator('text=Physical_Model').first();
    if (await firstImportRow.isVisible().catch(() => false)) {
      await firstImportRow.click();
      await page.waitForTimeout(600);
    }
  },
  async generateXmlIfNeeded(page) {
    // If nothing has been generated yet for this project, trigger it from the
    // Instances screen so the Generate screen shows real output.
    const emptyState = page.locator('.app-content').getByText('No XML generated yet');
    if (!(await emptyState.isVisible().catch(() => false))) return;

    await goToStep(page, 'Instances');
    const generateBtn = page.locator('.app-content').getByRole('button', { name: /Generate XML/i }).first();
    await generateBtn.click();
    // Generation streams progress; give it generous time to finish before moving on.
    await page.waitForTimeout(8000);
    await goToStep(page, 'Generate');
    await page.waitForTimeout(1000);
  },
};

async function loadActiveProject(page) {
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.getByText(PROJECT_NAME, { exact: true }).first().click();
  await page.waitForTimeout(1200);
}

async function goToStep(page, stepLabel) {
  await page.locator('button.sidebar-nav-item', { hasText: stepLabel }).click();
  await page.waitForTimeout(1000);
}

async function clickSubTab(page, subTabLabel) {
  if (!subTabLabel) return;
  // Scope to .app-content (sibling of the sidebar under .app-main) so this never
  // matches the sidebar step nav, which also contains labels like "Hierarchy".
  const target = page.locator('.app-content').getByText(subTabLabel, { exact: true }).first();
  await target.click();
  await page.waitForTimeout(800);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  await loadActiveProject(page);

  let lastStep = null;
  for (const [step, slug, subTab, beforeHook] of SHOTS) {
    if (step !== lastStep) {
      await goToStep(page, step);
      lastStep = step;
    }
    if (beforeHook && BEFORE_HOOKS[beforeHook]) {
      await BEFORE_HOOKS[beforeHook](page);
    }
    await clickSubTab(page, subTab);

    const filePath = path.join(OUT_DIR, `${slug}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    console.log(`captured ${slug}.png`);
  }

  await browser.close();
  console.log(`\nDone. ${SHOTS.length} screenshots written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
