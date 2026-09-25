# Repository Guidelines

## Project Structure & Module Organization

This is an ESM Node.js application for running browser RPA workflows that may pause for human SMS MFA input. `src/server.js` serves the static UI, exposes task APIs, authenticates requests with `API_TOKEN`, and binds task-specific WebSocket connections. `src/RpaSession.js` owns each task's status and the Promise-based pause/resume exchange for SMS codes. `src/rpaRunner.js` is the shared Playwright step interpreter; it launches an isolated browser context per task and executes a site's configured steps.

Keep target-specific behavior in `src/siteConfigs.js`. A site supplies its base URL, environment-backed credentials, and ordered `steps`; adding a site should normally not require edits to the server, session, or runner. Prefer Playwright semantic locator fields (`role`, `testId`, `label`, `text`, and `placeholder`) where they fit, with CSS `selector` as an alternative. The browser UI is deliberately dependency-free: `public/index.html` provides the shell and `public/app.js` handles task creation, WebSocket events, logs, and SMS-code submission. `docs/操作说明.md` is the operational setup guide, while `docs/方案设计.md` explains the architecture.

## Build, Test, and Development Commands

- `npm install` installs the declared dependencies.
- `npx playwright install chromium` installs the browser required by the RPA runner.
- `npm start` runs `src/server.js`.
- `npm run dev` runs the server with Node's watch mode.
- `npm run codegen -- https://example.com/login` starts Playwright code generation for recording locators for a target site.

The package does not define a test script or test framework. There is consequently no repository-provided single-test command.

## Coding Style & Naming Conventions

Use ES modules (`import`/`export`); `package.json` sets `"type": "module"`. Site configuration values that contain credentials should resolve from environment variables and be referenced by `valueRef` in steps, rather than being written as literals. The documented server token is also environment-backed (`API_TOKEN`). Do not commit `.env` files, logs, Playwright reports, or test results; these are ignored by Git. Preserve the existing action names when extending the interpreter or configuration: `goto`, `fill`, `click`, `waitForSelector`, `waitForUrl`, `waitSmsCode`, `download`, `sleep`, and `screenshot`.
