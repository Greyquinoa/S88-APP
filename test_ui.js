const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  // Navigate to the app
  await page.goto('http://localhost:5174');
  await page.waitForLoadState('networkidle');
  
  // Click on "Projects" to load the main page
  const projectLink = await page.locator('text=/rIX/i').first();
  if (await projectLink.isVisible()) {
    await projectLink.click();
    await page.waitForLoadState('networkidle');
  }
  
  // Go to Step MRP (which should contain the IO Import workflow)
  await page.click('text=/Step MRP|IO List/i');
  await page.waitForLoadState('networkidle');
  
  // Click on Column Mapping tab
  await page.click('text=/Column Mapping/i');
  await page.waitForLoadState('networkidle');
  
  // Take a screenshot of the new UI
  await page.screenshot({ path: 'column_mapping_ui.png', fullPage: true });
  console.log('Screenshot saved: column_mapping_ui.png');
  
  await browser.close();
})();
