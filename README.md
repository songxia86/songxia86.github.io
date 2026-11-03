# songxia86.github.io

InkDash renders the F1 dashboards listed in `dashboards/render.config.json` as
Kobo-sized PNGs and publishes them with GitHub Pages every 30 minutes.

To render locally, run `npm ci`, `npx playwright install chromium`, and
`node render.js`. Playwright captures PNGs at CSS-pixel scale, so ImageMagick is
not required. Run `npm test` to check version consistency and render a PNG
with Chromium without contacting the dashboard APIs.

## Reproducible CI runtime

The rendering job uses the official Playwright 1.58.2 Noble container, pinned
by SHA-256 digest, on an Ubuntu 24.04 host with Node.js 24. The container
already includes Chromium and its system libraries, so CI does not install
browsers or Ubuntu packages on each run. Host runner image changes cannot
replace the browser's OS or libraries.

The npm dependency is pinned to the same exact Playwright version.
Before rendering, `npm test` checks the image tag, exact dependency, lockfile,
and installed versions, then launches Chromium and verifies a PNG's dimensions.
The image digest makes the container immutable; the test catches version
drift during upgrades.

To upgrade Playwright:

1. Run `npm install --save-exact playwright@<version>`.
2. Update the container tag in `.github/workflows/deploy.yml` to the matching
   official image and replace its digest with that image's registry digest.
3. Run `npx playwright install chromium` and `npm test` locally. Validate the
   exact Linux container in GitHub Actions before relying on scheduled runs.
   Commit the manifest, lockfile, and workflow changes together.

If any configured page cannot render valid data at the configured resolution,
the build fails and deployment is skipped. GitHub Pages continues serving the
last successful deployment until a later run succeeds.