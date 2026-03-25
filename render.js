const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DASHBOARDS = path.join(__dirname, 'dashboards');
const CONFIG_PATH = path.join(DASHBOARDS, 'render.config.json');

function startServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(root, decodeURIComponent(req.url));
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const { configs } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (!configs || Object.keys(configs).length === 0) {
    console.log('No configs defined in render.config.json');
    return;
  }

  const server = await startServer(DASHBOARDS);
  const port = server.address().port;
  console.log(`Local server on port ${port}`);

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
      await page.goto(`http://127.0.0.1:${port}/${file}`, { waitUntil: 'networkidle' });

      // Wait for page to signal data is loaded (30s timeout)
      await page.waitForFunction(
        () => document.body.getAttribute('data-loaded') === 'true',
        { timeout: 30000 }
      ).catch(() => console.log(`  ⚠ ${file} did not set data-loaded, screenshotting anyway`));

      await page.screenshot({ path: pngPath, fullPage: false });
      await page.close();

      console.log(`  ✓ ${pngName}`);
    }

    await context.close();
  }

  await browser.close();
  server.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
