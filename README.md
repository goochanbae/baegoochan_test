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
