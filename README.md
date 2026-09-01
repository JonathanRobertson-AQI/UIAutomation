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
| `smoke-webkit` | `tests/smoke` | yes | yes — read-only |
| `full` | `tests` | yes | **no** — writes data |

Anything that creates, edits or deletes data belongs outside `tests/smoke`, so
that on-demand production runs stay read-only.

Firefox is not covered. The app never fires the `load` event under Firefox, and
the workarounds needed were not worth the signal for a browser the product does
not prioritise. `smoke-webkit` gives cross-browser coverage on demand.

### Data-mutating tests

`tests/full/worksheet-data-entry.spec.ts` writes a real value to a real
worksheet on the `JR Waste` test plant, so it must only run against
non-production environments.

It targets **today's row on the current month's daily worksheet**, which means
concurrent runs all aim at the same cell. `test.describe.configure({ mode:
'serial' })` orders the tests within a file, but Playwright still distributes
*repeats* across workers — so `--repeat-each` on this suite needs `--workers=1`:

```bash
npx playwright test --project=full --repeat-each=3 --workers=1
```

Without it, two workers write the same cell and each reads back the other's
value. The same caveat applies to running the suite from two machines at once
against one environment.

## How authentication works

The app uses OIDC implicit flow. A `setup` project signs in once per run and
saves the session to `playwright/.auth/`, which every authenticated test reuses.

Tokens are stored in localStorage, which Playwright's `storageState` captures.
They are short lived, so the sign-in runs on each invocation rather than being
cached between runs. `playwright/.auth/` is gitignored.

## Working with GUID routes

Ops routes embed customer- and environment-specific GUIDs, for example
`/ops/plant/<guid>/worksheet/4/view/<guid>`. Hardcoding those makes tests
environment-bound and brittle, so instead:

1. Page objects navigate by **clicking through the UI**, and read GUIDs back off
   the resulting URL (`OpsHomePage.currentPlantId()`).
2. Test data is configured by **name**, never by ID.
3. Locators use `getByRole` / `getByLabel` / `data-testid` rather than CSS paths.

## Two timing behaviours worth knowing

Both of these caused real test failures and are handled in `OpsHomePage`.

**The splash screen never disappears.** `#cm-splash-screen` stays in the DOM and
is only faded out with `opacity: 0; z-index: -10`, which Playwright still counts
as visible. Waiting for it to hide times out. The toolbar becoming visible is
the reliable "app has rendered" signal.

**Sign-in triggers a chain of redirects.** The app restores the user's last
context by walking `/ops/` to the plant, then the section, then the record,
finishing roughly four seconds after the shell renders. Clicking during that
window gets silently undone by the pending navigation. `waitForContextRestored()`
waits this out, and `goto()` calls it, so tests generally don't need to think
about it.

A third consequence: the app holds long-lived connections open, so the `load`
event and `networkidle` may never arrive — Firefox in particular never fires
`load` here. Navigation waits therefore use `waitUntil: 'domcontentloaded'` or
`'commit'`, and readiness is asserted explicitly instead.

## Known issues found while writing these tests

**Intermittent `Failed to login` console error.** Appears sporadically on load
while the app restores a session. There is no visible impact — the app loads
and works — but it is logged as a console error, so
`tests/smoke/ops-shell.spec.ts` filters it out to avoid a flaky gate. Worth
investigating in the app: it suggests a race in token restoration. Remove the
filter once it is fixed.

## Project layout

```
playwright.config.ts       # projects, baseURL, reporters, retries
src/config/env.ts          # validated environment configuration
src/pages/                 # page objects
src/fixtures/              # custom test fixtures
tests/public/              # signed-out tests
tests/smoke/               # authenticated read-only tests
tests/full/                # authenticated tests that write data
tests/auth.setup.ts        # one-time sign-in
.github/workflows/         # CI and on-demand workflow
```

## Adding tests

Import `test` and `expect` from the fixtures module so the page objects are
wired up automatically:

```ts
import { test, expect } from '../../src/fixtures/test';

test('does something @smoke', async ({ opsHome }) => {
  await opsHome.goto();
  await expect(opsHome.navLink('Reports')).toBeVisible();
});
```

Use `npm run codegen` to record selectors against the running app.
