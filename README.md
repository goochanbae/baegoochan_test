# UX Spatial Viewer

This repository contains the V1, V2, and V3 UX analysis web app.

## Local Run

```bash
npm ci
npm start
```

Open `http://localhost:3000`.

## GitHub Setup

GitHub itself does not host this Node server as a live app by default.
This repo is now prepared for two practical GitHub flows:

### 1. GitHub Actions

On every push to `main` and on pull requests, CI will:

- install dependencies
- run Node syntax checks
- start the server
- smoke test `/`, `/v3`, and `/api/v3/status`

Workflow file:

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)

### 2. GitHub Codespaces

This repo is also configured for Codespaces.

1. Open the repository on GitHub
2. Click `Code`
3. Open the `Codespaces` tab
4. Create a new Codespace
5. Run:

```bash
npm start
```

Port `3000` is preconfigured for forwarding.

Codespaces config:

- [`.devcontainer/devcontainer.json`](./.devcontainer/devcontainer.json)

## Environment Variables

Before running V3, create `.env` from `.env.example` and set your OpenRouter key(s).

## Render Deployment

This repo is also prepared for Render.

Relevant files:

- [`render.yaml`](./render.yaml)
- [`.node-version`](./.node-version)

Recommended Render settings for an existing Web Service:

- Runtime: `Node`
- Branch: `main`
- Build Command: `PLAYWRIGHT_BROWSERS_PATH=0 npm ci && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`
- Start Command: `npm start`

Required environment variable:

- `OPENROUTER_API_KEY`

Recommended additional Render environment variable:

- `PLAYWRIGHT_BROWSERS_PATH=0`

Optional V3 defaults are already listed in `render.yaml`.

Important note:

- If you already created the Render Web Service manually, `render.yaml` env vars are not automatically injected into that existing service unless you are using a Blueprint flow.
- For an existing service, set `PLAYWRIGHT_BROWSERS_PATH=0` directly in the Render dashboard as an environment variable.
