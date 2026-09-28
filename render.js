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
    throw new Error('No configs defined in render.config.json');
  }

  const failedRenders = [];
  const server = await startServer(DASHBOARDS);
  const port = server.address().port;
  console.log(`Local server on port ${port}`);

  const browser = await chromium.launch({
    args: [
      '--font-render-hinting=none',
      '--disable-lcd-text',
      '--force-color-profile=srgb',
    ],
  });

  for (const [configName, config] of Object.entries(configs)) {
    const { files, ...renderSettings } = config;

    if (!files || files.length === 0) {
      failedRenders.push(configName);
      console.error(`[${configName}] No files listed`);
      continue;
    }

    console.log(`[${configName}] ${renderSettings.width}x${renderSettings.height}`);

    const context = await browser.newContext({
      viewport: { width: renderSettings.width, height: renderSettings.height },
      deviceScaleFactor: renderSettings.deviceScaleFactor || 1,
      colorScheme: renderSettings.colorScheme || 'light',
    });

    const MIN_PNG_SIZE = 20000; // Valid dashboard PNGs are >20KB
    const RENDER_MAX_RETRIES = 3;

    for (const file of files) {
      const filePath = path.join(DASHBOARDS, file);

      if (!fs.existsSync(filePath)) {
        failedRenders.push(file);
        console.error(`  ✗ ${file} not found`);
        continue;
      }

      const pngName = file.replace(/\.html$/, `.${configName}.png`);
      const pngPath = path.join(DASHBOARDS, pngName);

      // Back up previous good PNG
      const prevPath = pngPath + '.prev';
      if (fs.existsSync(pngPath)) {
        const prevSize = fs.statSync(pngPath).size;
        if (prevSize >= MIN_PNG_SIZE) {
          fs.copyFileSync(pngPath, prevPath);
        }
      }

      let renderOk = false;

      for (let attempt = 0; attempt < RENDER_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          console.log(`  ↻ ${file} retry ${attempt + 1}/${RENDER_MAX_RETRIES}`);
          await new Promise(r => setTimeout(r, 5000 * attempt));
        }

        let page;
        try {
          page = await context.newPage();
          await page.goto(`http://127.0.0.1:${port}/${file}`, { waitUntil: 'domcontentloaded' });

          await page.waitForFunction(
            () => document.fonts.ready.then(() => true),
            null,
            { timeout: 10000 }
          );
          await page.waitForFunction(
            () => document.body.getAttribute('data-loaded') === 'true',
            null,
            { timeout: 90000 }
          );

          const status = await page.evaluate(() => document.body.getAttribute('data-status'));
          if (status === 'error') throw new Error('dashboard reported a data error');

          const png = await page.screenshot({ path: pngPath, fullPage: false, scale: 'css' });
          const width = png.readUInt32BE(16);
          const height = png.readUInt32BE(20);
          if (width !== renderSettings.width || height !== renderSettings.height) {
            throw new Error(`unexpected PNG dimensions ${width}x${height}`);
          }
          if (png.length < MIN_PNG_SIZE) {
            throw new Error(`PNG too small (${(png.length / 1024).toFixed(1)}KB)`);
          }

          renderOk = true;
          console.log(`  ✓ ${pngName} (${(png.length / 1024).toFixed(0)}KB)`);
          if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
          break;
        } catch (err) {
          console.warn(`  ⚠ ${file} render attempt ${attempt + 1} failed: ${err.message}`);
        } finally {
          if (page) await page.close();
        }
      }

      if (!renderOk) {
        failedRenders.push(pngName);
        if (fs.existsSync(prevPath)) {
          fs.copyFileSync(prevPath, pngPath);
          fs.unlinkSync(prevPath);
          console.log(`  ✗ ${pngName} FAILED, restored previous version`);
        } else {
          console.log(`  ✗ ${pngName} FAILED, no previous version to restore`);
        }
      }

      // Delay between files to avoid API rate limits
      await new Promise(r => setTimeout(r, 3000));
    }

    await context.close();
  }

  await browser.close();
  server.close();

  if (failedRenders.length) {
    throw new Error(`Rendering failed for: ${failedRenders.join(', ')}`);
  }

  // Generate index.html with links to all HTML and PNG files
  const allFiles = fs.readdirSync(DASHBOARDS)
    .filter(f => f.endsWith('.html') || f.endsWith('.png'))
    .sort();
  const htmlFiles = allFiles.filter(f => f.endsWith('.html') && f !== 'index.html');
  const pngFiles = allFiles.filter(f => f.endsWith('.png'));

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  let idx = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>InkDash Dashboards</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #333; }
h1 { font-size: 24px; margin-bottom: 4px; }
p.ts { font-size: 12px; color: #999; margin-bottom: 24px; }
h2 { font-size: 16px; color: #666; margin: 24px 0 8px; }
ul { list-style: none; padding: 0; }
li { margin: 6px 0; }
a { color: #333; text-decoration: none; padding: 6px 10px; display: inline-block; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
a:hover { background: #f4f4f4; border-color: #bbb; }
.png-grid { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; }
.png-card { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; width: 220px; }
.png-card img { width: 100%; display: block; }
.png-card .label { padding: 6px 10px; font-size: 12px; color: #666; }
</style></head><body>
<h1>InkDash Dashboards</h1>
<p class="ts">Last rendered: ${ts}</p>`;

  if (htmlFiles.length) {
    idx += `<h2>HTML Sources</h2><ul>`;
    htmlFiles.forEach(f => { idx += `<li><a href="${f}">${f}</a></li>`; });
    idx += `</ul>`;
  }

  if (pngFiles.length) {
    idx += `<h2>Rendered PNGs</h2><div class="png-grid">`;
    pngFiles.forEach(f => {
      idx += `<div class="png-card"><a href="${f}"><img src="${f}" alt="${f}"></a><div class="label">${f}</div></div>`;
    });
    idx += `</div>`;
  }

  idx += `</body></html>`;
  fs.writeFileSync(path.join(DASHBOARDS, 'index.html'), idx);
  console.log('✓ index.html');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
