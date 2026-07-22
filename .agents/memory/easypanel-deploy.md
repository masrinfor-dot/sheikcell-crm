---
name: EasyPanel deploy gotchas
description: Lessons for building the web app in Docker on the user's EasyPanel VPS
---
- Docker build images for the web (Vite) app must be Debian/glibc (`node:24-slim`), not alpine: the Rollup native binary for musl is absent from the pnpm lockfile (generated on glibc), so `vite build` crashes only on alpine.
- **Why:** lockfile pins optional native deps per platform of the machine that generated it.
- **How to apply:** any new Dockerfile that runs `vite build`/rollup must use a glibc base image, or the musl optional dep must be added explicitly.
- Login in prod needs `app.set("trust proxy", 1)` in the Express api: HTTPS terminates at the EasyPanel proxy, so the `secure` session cookie is refused without it.
- Each EasyPanel service gets its own subdomain; the web nginx must proxy `/api/` to the api service host (`<project>_<service>`, e.g. `http://sheik_api:8080`) or API calls 405 at nginx and login silently does nothing.
- Debugging prod is fastest by curling the public domain directly (e.g. `/api/healthz`, POST login) from the workspace.
- Deploy failures often reuse an old commit: check the `GIT_SHA` in the EasyPanel log against the pushed `producao` head before debugging code.
