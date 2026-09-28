# songxia86.github.io

InkDash renders the F1 dashboards listed in `dashboards/render.config.json` as
Kobo-sized PNGs and publishes them with GitHub Pages every 30 minutes.

To render locally, run `npm ci`, `npx playwright install chromium`, and
`node render.js`. Playwright captures PNGs at CSS-pixel scale, so ImageMagick is
not required. CI runs `npx playwright install --with-deps chromium`, which
refreshes Ubuntu's package index before installing browser dependencies.

If any configured page cannot render valid data at the configured resolution,
the build fails and deployment is skipped. GitHub Pages continues serving the
last successful deployment until a later run succeeds.