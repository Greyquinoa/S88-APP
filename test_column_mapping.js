const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    // Navigate to the app
    console.log('Opening app...');
    await page.goto('http://localhost:5174', { waitUntil: 'networkidle' });

    // Click on rIX project
    console.log('Clicking rIX project...');
    await page.click('text=/rIX/i');
    await page.waitForLoadState('networkidle');

    // Navigate to Step MRP/IO section
    console.log('Looking for Step MRP...');
    const stepMrp = await page.locator('[role="tab"]:has-text("Step MRP")').first();
    if (await stepMrp.isVisible()) {
      await stepMrp.click();
      await page.waitForLoadState('networkidle');
    }

    // Click Column Mapping tab
    console.log('Clicking Column Mapping tab...');
    const colMapTab = await page.locator('[role="tab"]:has-text("Column Mapping")').first();
    if (await colMapTab.isVisible()) {
      await colMapTab.click();
      await page.waitForLoadState('networkidle');

      // Take screenshot
      await page.screenshot({ path: 'column_mapping_redesign.png' });
      console.log('✓ Screenshot saved: column_mapping_redesign.png');
    } else {
      console.log('Column Mapping tab not found');
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
})();
