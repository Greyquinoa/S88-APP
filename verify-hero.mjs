import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5177', { waitUntil: 'networkidle' });
  
  // Check if Nimbus hero section is present
  const heroTitle = await page.locator('h1').first();
  const titleText = await heroTitle.textContent();
  
  console.log('Hero Title Found:', titleText);
  
  // Check for key feature cards
  const cards = await page.locator('.nimbus-card').count();
  console.log(`Feature cards found: ${cards}`);
  
  // Get first card content
  const firstCard = await page.locator('.nimbus-card-intro').first();
  const cardText = await firstCard.textContent();
  console.log('First card preview:', cardText?.substring(0, 100));
  
  await page.screenshot({ path: 's88x-hero.png', fullPage: true });
  console.log('Screenshot saved to s88x-hero.png');
  
  await browser.close();
})();
