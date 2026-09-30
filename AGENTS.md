# Repository Guidelines

## Project Structure & Module Organization

This is an ESM Node.js application for running browser RPA workflows that may pause for human SMS MFA input. `src/server.js` serves the static UI, exposes unauthenticated task APIs (testing only), and binds task-specific WebSocket connections. `src/RpaSession.js` owns each task's status and the Promise-based pause/resume exchange for SMS codes. `src/rpaRunner.js` is the shared Playwright step interpreter; it launches an isolated browser context per task and executes a site's configured steps.

Keep target-specific behavior in `src/siteConfigs.js`. A site supplies its base URL, environment-backed credentials, and ordered `steps`; adding a site should normally not require edits to the server, session, or runner. Prefer Playwright semantic locator fields (`role`, `testId`, `label`, `text`, and `placeholder`) where they fit, with CSS `selector` as an alternative. The browser UI is deliberately dependency-free: `public/index.html` provides the shell and `public/app.js` handles task creation, WebSocket events, logs, and SMS-code submission. `docs/操作说明.md` is the operational setup guide, while `docs/方案设计.md` explains the architecture.

## Build, Test, and Development Commands

- `npm install` installs the declared dependencies.
- `npx playwright install --with-deps chrome` installs Google Chrome plus its Linux system libraries; the runner launches `channel: 'chrome'`, so bundled Chromium is not enough.
- `npm run agent` runs `src/agent.js`, the CDI-facing agent. This is how the project is started for local dev (PowerShell):
  ```powershell
  $env:RPA_AGENT_TOKEN="47dfec45493677836284849a978d14c64b57694bdaae47baacaeef810ab67776"
  $env:RPA_AGENT_PORT="3000"
  npm run agent
  ```
- Treat “start”, “start the repo”, and “start rpa” as requests to run all three PowerShell commands above and leave the agent running. Do not start `npm start` instead.
- `npm start` runs `src/server.js` (local browser UI; also defaults to port `3000`, so it cannot run alongside the agent on that port).
- `npm run dev` runs the server with Node's watch mode.
- `npm run codegen -- https://example.com/login` starts Playwright code generation for recording locators for a target site.

The package does not define a test script or test framework. There is consequently no repository-provided single-test command.

## Deployment

`.gitlab-ci.yml` defines the cloud pipeline on the `mcr.microsoft.com/playwright:v1.63.0-noble` image; keep that tag in step with the `playwright` version in `package-lock.json`. Every job's `before_script` runs `npm ci` and `npx playwright install --with-deps chrome` (the driver install). The `build` stage runs `node --check` on the main sources; the manual `run-agent` job in the `deploy` stage is the start command, `npm run agent`. All sites run `headless: true` because cloud runners have no display.

Runtime secrets are never committed. `.env.example` lists every variable the code reads; locally, copy it to `.env` (loaded by `--env-file-if-exists`), and in GitLab, add each one under **Settings → CI/CD → Variables**, marking tokens and passwords as Masked:

- `RPA_AGENT_TOKEN` (optional; overrides the fixed token in `src/agent.js`, which must match csd-ai-service `RPA_AGENT_TOKEN`), `RPA_AGENT_PORT`, `RPA_AGENT_ID`, `RPA_RUN_RETENTION_MINUTES`, `RPA_MAX_ACTIVE_RUNS` (default `3`).
- Site credentials such as `CDI_UAT_USERNAME` and `CDI_UAT_PASSWORD`. When a new site adds an env-backed credential, add it to `.env.example` and the GitLab variables.

To deploy: push to the GitLab repo, let `build` pass, set the variables, then trigger `run-agent` from **CI/CD → Pipelines**. The `run-agent` job is long-running and bound by the job timeout, and it does not expose the port to CDI on its own; a persistent host or container deployment must reuse the same install and start commands.

## API Surface

`src/server.js` provides the local browser UI API on `PORT` (default `3000`):

- `POST /api/tasks` needs no auth and accepts `{ "taskName?", "userName?", "password?" }` (`taskName` defaults to `cdiUat`). `userName` overrides the site's default username; `password` is used only when the site's `requiredFields` includes it (e.g. `lijuan_amazon` requires both `userName` and `password`; `cdiUat` requires neither and instead pauses for the email via a `waitEmail` step). It returns a `sessionId` and a session-specific `wsToken`.
- `GET /api/sites` returns the configured site keys.
- WebSocket connections use `?sessionId=<id>&wsToken=<token>`; clients submit SMS codes as `{ "type": "SMS_CODE", "code": "<code>" }` and login emails as `{ "type": "EMAIL", "email": "<email>" }`.

`src/agent.js` provides the CDI-facing agent API on `RPA_AGENT_PORT` (default `3100`). Every `/agent/**` endpoint requires `Authorization: Bearer <token>`, where the token is the fixed value in `src/agent.js` unless `RPA_AGENT_TOKEN` overrides it:

- `POST /agent/runs` accepts `{ "run_id", "taskName", "userName?", "password?", "ingestion?" }` and starts a run. Field semantics match `POST /api/tasks`: `taskName` is a `siteConfigs` key, and the site's `requiredFields` are enforced with 400. Returns 429 when `RPA_MAX_ACTIVE_RUNS` runs are already active, and 503 while the agent is shutting down (SIGTERM/SIGINT cancels active runs and closes their browsers before exit). `ingestion` is accepted but not used yet.
- `GET /agent/runs/:runId` returns a run status snapshot.
- `POST /agent/runs/:runId/mfa-code` accepts `{ "code": "<4-10 digit code>" }`.
- `POST /agent/runs/:runId/email` accepts `{ "email": "<email>" }` while the run is `waiting_email` (sites with a `waitEmail` step, e.g. `cdiUat`); 409 otherwise.
- `POST /agent/runs/:runId/cancel` requests cancellation after the current step.
- `GET /agent/health` returns the agent ID, configured sites, and active-run count.

## Coding Style & Naming Conventions

Use ES modules (`import`/`export`); `package.json` sets `"type": "module"`. Site configuration values that contain credentials should resolve from environment variables and be referenced by `valueRef` in steps, rather than being written as literals. Do not commit `.env` files, logs, Playwright reports, or test results; these are ignored by Git. Preserve the existing action names when extending the interpreter or configuration: `goto`, `fill`, `click`, `waitForSelector`, `waitForUrl`, `waitSmsCode`, `waitEmail`, `download`, `upload`, `sleep`, and `screenshot`.
