# Repository Guidelines

## Project Structure & Module Organization

This is an ESM Node.js application for running browser RPA workflows that may pause for human SMS MFA input. `src/server.js` serves the static UI, exposes unauthenticated task APIs (testing only), and binds task-specific WebSocket connections. `src/RpaSession.js` owns each task's status and the Promise-based pause/resume exchange for SMS codes. `src/rpaRunner.js` is the shared Playwright step interpreter; it launches an isolated browser context per task and executes a site's configured steps.

Keep target-specific behavior in `src/siteConfigs.js`. A site supplies its base URL, environment-backed credentials, and ordered `steps`; adding a site should normally not require edits to the server, session, or runner. Prefer Playwright semantic locator fields (`role`, `testId`, `label`, `text`, and `placeholder`) where they fit, with CSS `selector` as an alternative. The browser UI is deliberately dependency-free: `public/index.html` provides the shell and `public/app.js` handles task creation, WebSocket events, logs, and SMS-code submission. `docs/操作说明.md` is the operational setup guide, while `docs/方案设计.md` explains the architecture.

## Build, Test, and Development Commands

- `npm install` installs the declared dependencies.
- `npx playwright install chromium` installs the browser required by the RPA runner.
- `npm run agent` runs `src/agent.js`, the CDI-facing agent. This is how the project is started for local dev (PowerShell):
  ```powershell
  $env:RPA_AGENT_TOKEN="local-dev-rpa-token"
  $env:RPA_AGENT_PORT="3000"
  npm run agent
  ```
- `npm start` runs `src/server.js` (local browser UI; also defaults to port `3000`, so it cannot run alongside the agent on that port).
- `npm run dev` runs the server with Node's watch mode.
- `npm run codegen -- https://example.com/login` starts Playwright code generation for recording locators for a target site.

The package does not define a test script or test framework. There is consequently no repository-provided single-test command.

## API Surface

`src/server.js` provides the local browser UI API on `PORT` (default `3000`):

- `POST /api/tasks` needs no auth and accepts `{ "taskName?", "userName?", "password?" }` (`taskName` defaults to `cdiUat`). `userName` overrides the site's default username; `password` is used only when the site's `requiredFields` includes it (e.g. `lijuan_amazon` requires both `userName` and `password`; `cdiUat` requires neither and instead pauses for the email via a `waitEmail` step). It returns a `sessionId` and a session-specific `wsToken`.
- `GET /api/sites` returns the configured site keys.
- WebSocket connections use `?sessionId=<id>&wsToken=<token>`; clients submit SMS codes as `{ "type": "SMS_CODE", "code": "<code>" }` and login emails as `{ "type": "EMAIL", "email": "<email>" }`.

`src/agent.js` provides the CDI-facing agent API on `RPA_AGENT_PORT` (default `3100`). Every endpoint requires `Authorization: Bearer <RPA_AGENT_TOKEN>`; the service refuses to start when that token is unset:

- `POST /agent/runs` accepts `{ "run_id", "taskName", "userName?", "password?", "ingestion?" }` and starts a run. Field semantics match `POST /api/tasks`: `taskName` is a `siteConfigs` key, and the site's `requiredFields` are enforced with 400. `ingestion` is accepted but not used yet.
- `GET /agent/runs/:runId` returns a run status snapshot.
- `POST /agent/runs/:runId/mfa-code` accepts `{ "code": "<4-10 digit code>" }`.
- `POST /agent/runs/:runId/email` accepts `{ "email": "<email>" }` while the run is `waiting_email` (sites with a `waitEmail` step, e.g. `cdiUat`); 409 otherwise.
- `POST /agent/runs/:runId/cancel` requests cancellation after the current step.
- `GET /agent/health` returns the agent ID, configured sites, and active-run count.

`src/cdiClient.js` is an outbound client, not a local endpoint. When `CDI_BASE_URL` is configured, it posts run events to `POST {CDI_BASE_URL}/api/v1/reporting-rpa/agent/runs/:runId/events` with `Authorization: Bearer <CDI_API_TOKEN>`.

## Coding Style & Naming Conventions

Use ES modules (`import`/`export`); `package.json` sets `"type": "module"`. Site configuration values that contain credentials should resolve from environment variables and be referenced by `valueRef` in steps, rather than being written as literals. Do not commit `.env` files, logs, Playwright reports, or test results; these are ignored by Git. Preserve the existing action names when extending the interpreter or configuration: `goto`, `fill`, `click`, `waitForSelector`, `waitForUrl`, `waitSmsCode`, `waitEmail`, `download`, `upload`, `sleep`, and `screenshot`.
