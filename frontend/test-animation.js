import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Navigate to the app
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  
  // Wait for the app to load
  await page.waitForTimeout(2000);
  
  // Take screenshot of home page
  await page.screenshot({ path: 'screenshot-home.png', fullPage: true });
  console.log('Screenshot saved: screenshot-home.png');
  
  // Try to navigate to Library tab by looking for it in the sidebar
  const libraryButton = await page.locator('[href="/library"]').first();
  if (await libraryButton.isVisible()) {
    await libraryButton.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshot-library.png', fullPage: true });
    console.log('Screenshot saved: screenshot-library.png');
  }
  
  await browser.close();
}

test().catch(console.error);
