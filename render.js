const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DASHBOARDS = path.join(__dirname, 'dashboards');
const CONFIG_PATH = path.join(DASHBOARDS, 'render.config.json');

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const defaults = config.defaults || {};
  const overrides = config.files || {};

  const htmlFiles = fs.readdirSync(DASHBOARDS).filter(f => f.endsWith('.html'));

  if (htmlFiles.length === 0) {
    console.log('No HTML files found in dashboards/');
    return;
  }

  const browser = await chromium.launch();

  for (const file of htmlFiles) {
    const settings = { ...defaults, ...overrides[file] };
    const filePath = path.join(DASHBOARDS, file);
    const pngPath = filePath.replace(/\.html$/, '.png');

    console.log(`Rendering ${file} → ${path.basename(pngPath)} (${settings.width}x${settings.height})`);

    const context = await browser.newContext({
      viewport: { width: settings.width, height: settings.height },
      deviceScaleFactor: settings.deviceScaleFactor || 1,
      colorScheme: settings.colorScheme || 'light',
    });

    const page = await context.newPage();
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: pngPath, fullPage: false });
    await context.close();

    console.log(`  ✓ ${pngPath}`);
  }

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
