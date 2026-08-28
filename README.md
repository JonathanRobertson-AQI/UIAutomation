# AQI UI Automation

Playwright UI tests for the AQI ops application.

Two ways to run:

- **Automated** — on pull requests and nightly against the feature environment.
- **On demand** — from the GitHub Actions tab, pointed at any published environment.

## Setup

```bash
npm ci
npx playwright install
cp .env.example .env   # PowerShell: Copy-Item .env.example .env
```

### Where to put your credentials

Open the **`.env`** file in the repo root and fill in:

```
BASE_URL=https://feature-us.aquaticinformatics.net/ops/
TEST_USER=your.test.account@example.com
TEST_PASSWORD=your-password
TEST_PLANT_NAME=Some Plant
```

`.env` is gitignored, so it never gets committed. Don't paste credentials into
source files, commit messages, or chat.

For CI, the same values live in the repository settings:

| Value | Where it goes |
| --- | --- |
| `TEST_USER` | Settings → Secrets and variables → Actions → **Secrets** |
| `TEST_PASSWORD` | Settings → Secrets and variables → Actions → **Secrets** |
| `BASE_URL` | Settings → Secrets and variables → Actions → **Variables** |
| `TEST_PLANT_NAME` | Settings → Secrets and variables → Actions → **Variables** |
| `TEST_WORKSHEET_NAME` | Settings → Secrets and variables → Actions → **Variables** |

## Running tests

```bash
npm run test:public   # signed-out checks, no credentials needed
npm run test:smoke    # read-only, safe against any environment
npm run test:full     # includes data-mutating tests, non-production only
npm run test:ui       # interactive UI mode - best for authoring and debugging
npm run report        # open the last HTML report
```

Point any run at a different environment by overriding `BASE_URL`:

```bash
# PowerShell
$env:BASE_URL='https://other-env.aquaticinformatics.net/ops/'; npm run test:smoke
```

### On-demand runs against a published site

Actions → **UI Tests** → *Run workflow*, then choose the base URL and the suite.
The HTML report is uploaded as a build artifact.

## Test suites

| Project | Directory | Auth | Safe in production |
| --- | --- | --- | --- |
| `public` | `tests/public` | none | yes |
| `smoke` | `tests/smoke` | yes | yes — read-only |
| `smoke-firefox` / `smoke-webkit` | `tests/smoke` | yes | yes — read-only |
| `full` | `tests` | yes | **no** — may modify data |

Anything that creates, edits or deletes data belongs outside `tests/smoke`, so
that on-demand production runs stay read-only.

## How authentication works

The app uses OIDC implicit flow. A `setup` project signs in once per run and
saves the session to `playwright/.auth/`, which every authenticated test reuses.

Playwright's `storageState` covers cookies and localStorage but not
sessionStorage, so `src/fixtures/sessionStorage.ts` captures and replays
sessionStorage as well. That keeps auth reuse working regardless of where the
app stores its tokens.

Tokens are short lived, so the sign-in runs on each invocation rather than
being cached between runs. `playwright/.auth/` is gitignored.

## Working with GUID routes

Ops routes embed customer- and environment-specific GUIDs, for example
`/ops/plant/<guid>/worksheet/4/view/<guid>`. Hardcoding those makes tests
environment-bound and brittle, so instead:

1. Page objects navigate by **clicking through the UI**, and read GUIDs back off
   the resulting URL (`OpsHomePage.currentPlantId()`).
2. Test data is configured by **name** (`TEST_PLANT_NAME`), never by ID.
3. Locators use `getByRole` / `getByLabel` / `data-testid` rather than CSS paths.

## Project layout

```
playwright.config.ts       # projects, baseURL, reporters, retries
src/config/env.ts          # validated environment configuration
src/pages/                 # page objects
src/fixtures/              # custom test fixtures
tests/public/              # signed-out tests
tests/smoke/               # authenticated read-only tests
tests/auth.setup.ts        # one-time sign-in
.github/workflows/         # CI and on-demand workflow
```

## Adding tests

Import `test` and `expect` from the fixtures module so page objects and
sessionStorage handling are wired up automatically:

```ts
import { test, expect } from '../../src/fixtures/test';

test('does something @smoke', async ({ opsHome }) => {
  await opsHome.goto();
  await opsHome.waitForAppReady();
});
```

Use `npm run codegen` to record selectors against the running app.

> The authenticated page objects were written without access to a test account.
> Once you have one, confirm the accessible names with `npm run test:ui` or
> `npm run codegen` and refine `src/pages/OpsHomePage.ts` as needed.
