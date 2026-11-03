const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { version } = require('playwright/package.json');
const { dependencies } = require('./package.json');
const lockfile = require('./package-lock.json');

test('Playwright matches the pinned container, manifest, and lockfile', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '.github/workflows/deploy.yml'), 'utf8');
  const image = workflow.match(/^\s+image: mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-[a-z0-9]+@sha256:[a-f0-9]{64}\s*$/m);

  assert.ok(image, 'Use an official Playwright image pinned by version and SHA-256 digest');
  assert.equal(image[1], version, 'Update the Playwright container and npm dependency together');
  assert.equal(dependencies.playwright, version, 'Pin the exact Playwright dependency version');
  assert.equal(lockfile.packages[''].dependencies.playwright, version);
  assert.equal(lockfile.packages['node_modules/playwright'].version, version);
  assert.equal(lockfile.packages['node_modules/playwright-core'].version, version);
});

test('Chromium launches and renders a correctly sized PNG', { timeout: 30000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 600, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.setContent('<!doctype html><html><body><h1>InkDash runtime check</h1></body></html>');
    await page.evaluate(() => document.fonts.ready);

    const png = await page.screenshot({ scale: 'css' });
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), 600);
    assert.equal(png.readUInt32BE(20), 800);
  } finally {
    await browser.close();
  }
});
