const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

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
      console.log(`[${configName}] No files listed, skipping`);
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
        console.log(`  ✗ ${file} not found, skipping`);
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

        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}/${file}`, { waitUntil: 'networkidle' });

        // Wait for fonts to fully load
        await page.waitForFunction(
          () => document.fonts.ready.then(() => true),
          { timeout: 10000 }
        ).catch(() => {});

        // Wait for page to signal data is loaded (45s timeout to allow retries in HTML)
        await page.waitForFunction(
          () => document.body.getAttribute('data-loaded') === 'true',
          { timeout: 45000 }
        ).catch(() => console.log(`  ⚠ ${file} did not set data-loaded`));

        // Wait for all images (headshots, flags, track maps) to finish loading
        await page.waitForFunction(
          () => {
            var imgs = document.images;
            if (imgs.length === 0) return true;
            return Array.from(imgs).every(function(img) { return img.complete && img.naturalWidth > 0; });
          },
          { timeout: 15000 }
        ).catch(() => console.log(`  ⚠ ${file} some images may not have loaded`));

        // Extra settle time for late-loading images
        await new Promise(r => setTimeout(r, 2000));

        // Check if the page rendered successfully (not an error state)
        const status = await page.evaluate(() => document.body.getAttribute('data-status'));
        if (status === 'error') {
          console.log(`  ⚠ ${file} rendered with error state, skipping screenshot`);
          await page.close();
          continue;
        }

        await page.screenshot({ path: pngPath, fullPage: false });
        await page.close();

        // Downsample if needed
        const scale = renderSettings.deviceScaleFactor || 1;
        if (scale > 1) {
          const tW = renderSettings.width;
          const tH = renderSettings.height;
          const cmds = [
            `convert '${pngPath}' -resize ${tW}x${tH} -filter Lanczos '${pngPath}'`,
            `sips -z ${tH} ${tW} '${pngPath}'`,
          ];
          for (const cmd of cmds) {
            try { execSync(cmd + ' 2>/dev/null'); break; } catch(e) {}
          }
        }

        // Validate PNG size
        const size = fs.statSync(pngPath).size;
        if (size >= MIN_PNG_SIZE) {
          renderOk = true;
          console.log(`  ✓ ${pngName} (${(size/1024).toFixed(0)}KB)`);
          if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
          break;
        } else {
          console.log(`  ⚠ ${pngName} too small (${(size/1024).toFixed(1)}KB)`);
        }
      }

      // If all retries failed, restore previous good PNG
      if (!renderOk) {
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
