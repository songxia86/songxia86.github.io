const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DASHBOARDS = path.join(__dirname, 'dashboards');
const CONFIG_PATH = path.join(DASHBOARDS, 'render.config.json');

async function main() {
  const { configs } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (!configs || Object.keys(configs).length === 0) {
    console.log('No configs defined in render.config.json');
    return;
  }

  const browser = await chromium.launch();

  for (const [configName, config] of Object.entries(configs)) {
    const { files, ...renderSettings } = config;

    if (!files || files.length === 0) {
      console.log(`[${configName}] No files listed, skipping`);
      continue;
    }

    console.log(`[${configName}] ${renderSettings.width}x${renderSettings.height}`);

    const context = await browser.newContext({
      viewport: { width: renderSettings.width, height: renderSettings.height },
      deviceScaleFactor: renderSettings.deviceScaleFactor || 1,
      colorScheme: renderSettings.colorScheme || 'light',
    });

    for (const file of files) {
      const filePath = path.join(DASHBOARDS, file);

      if (!fs.existsSync(filePath)) {
        console.log(`  ✗ ${file} not found, skipping`);
        continue;
      }

      const pngName = file.replace(/\.html$/, `.${configName}.png`);
      const pngPath = path.join(DASHBOARDS, pngName);

      const page = await context.newPage();
      await page.goto(`file://${filePath}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: pngPath, fullPage: false });
      await page.close();

      console.log(`  ✓ ${pngName}`);
    }

    await context.close();
  }

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
