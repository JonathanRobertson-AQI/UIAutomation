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

### Auditing a whole tenant

`tests/full/rtc-tenant-audit.spec.ts` walks every operation under one tenant and
reports which ones have data. It is read-only, but it targets seeded load-test
tenants, so it lives in `full` rather than `smoke`.

```bash
npx playwright test --project=full tests/full/rtc-tenant-audit.spec.ts
```

It writes a Markdown report — operation name, sub-tenant, link, and whether data
was found — to `test-results/rtc-tenant-audit.md`, and attaches it to the HTML
report. The test fails if any operation lacks data, and the failure message
names the first twenty.

#### Which date each frequency is checked against

The two frequencies become complete at different times, so checking both against
"today" reports healthy plants as broken:

- **Daily is checked against yesterday.** A daily value is an aggregate of the
  whole day's inputs, so it cannot be complete until the day is over. Today's
  row is legitimately empty for the entire day.
- **15 Minute is checked against today**, but only for slots that have closed
  *and* had time to settle. A value appears roughly a slot-length after its
  period ends, so `WorksheetPage.SLOT_MINUTES + SETTLE_MINUTES` (30 minutes) is
  subtracted from the current time and anything later is ignored. The slot in
  progress and the one that just closed are expected to be empty.

The report states both dates explicitly, and each row shows the date or slot
range behind its verdict, so a result can be checked without re-reading the code.

Environment variables let it be pointed elsewhere without editing the spec:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUDIT_TENANT` | `RtcLpt-Root-2026-08-26 17:23:03Z` | Tenant to walk |
| `AUDIT_PREFIX` | `RTCPlant` | Only audit operations whose name starts with this |
| `AUDIT_CONCURRENCY` | `3` | Operations checked at once |
| `AUDIT_LIMIT` | unset | Stop after N operations, for a quick smoke check |

A few things about it are worth knowing:

- **It does not drive the operation picker.** The app loads the entire operation
  hierarchy on boot to populate that picker, so `OperationDirectory` captures
  that response and resolves operations straight to their route GUIDs. Driving
  the picker 150 times — a search and a full tree expansion each — would take
  roughly an hour.
- **Deep links must omit the worksheet number.** `/plant/<id>/worksheet` is
  honoured; `/plant/<id>/worksheet/4` is *silently redirected to whichever
  operation the user was last on*, and still renders a healthy worksheet, so the
  numbers would quietly belong to the wrong plant. `gotoOperationWorksheet()`
  asserts the landed GUID for exactly this reason.
- **A cold page loses the first deep link.** On a freshly opened page the app
  restores the user's last context while booting, and that restore can outrun
  the deep link — you land on the previous operation instead. Navigating again
  once the app is warm sticks, so `gotoOperationWorksheet()` retries rather than
  treating the first landing as final. This only shows up when the last-used
  operation differs from the one being requested, which is why it can lie
  dormant for a whole run and then fail everything.
- **"Could not be read" is not "no data".** Every navigation re-boots the SPA and
  refetches several megabytes of hierarchy, which occasionally times out. Those
  operations are retried, then reported separately — calling them empty would
  blame the seeding job for a test-harness problem.
- **Video and traces are disabled for this spec.** At 150 navigations they run to
  gigabytes and once filled the disk mid-run. The report is the artefact worth
  keeping; anything that needs a trace can be re-run as a single operation.
- **An empty worksheet costs an extra 15 seconds.** A zero reading is only
  trusted once it has held for that long — see the value-load race under [known
  issues](#known-issues-found-while-writing-these-tests). Without that hold the
  audit is not reproducible, so the time is not optional.
- **The 15 Minute grid is virtualised.** A day holds 96 slots but only a
  screenful exists in the DOM, so the scan pages through the grid. It stops at
  the first populated slot, which keeps "has data" fast while making "no data"
  rest on the whole day rather than one screenful.

### Picking an operation

`OpsHomePage.switchToOperation()` drives the toolbar's operation picker. Two
things about that dialog are easy to get wrong:

- **Searching is not enough.** The search box narrows the tree to matching
  branches but leaves them *collapsed*, so the matching leaf is not in the DOM
  until "Expand all" is clicked. Searching alone finds nothing.
- **Names are not unique.** The same operation name can exist under many
  tenants — the RTC load-test plants below appear about fifteen times each. The
  method therefore exposes a `pick` callback to choose among the matches.

A user only sees operations under tenants they belong to, so the tree differs
per account. Access changes require a fresh sign-in, because tenant membership
is carried in the token: delete `playwright/.auth/` and re-run the `setup`
project after being granted a new tenant.

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

**Worksheet edits can be lost if you navigate immediately.** The grid shows an
edited value as soon as it is committed locally, roughly 600ms before the write
reaches the API, and there is no explicit save or pending indicator. Reloading
inside that window silently discards the entry. `WorksheetPage.enterValue()`
waits for the row-save POST to return 2xx rather than trusting the rendered
cell, which is what makes the data-entry test reliable.

**Worksheet values arrive long after the grid renders.** The grid draws its rows
and columns from the worksheet *definition*, which returns well before the
*values* do — measured at up to 14.5 seconds later on a busy server. Nothing in
the UI distinguishes "no data" from "data still loading": both render as empty
cells. Counting straight after the grid appears therefore reports populated
worksheets as empty, and because the delay varies, the same plant can come back
differently on consecutive runs.

Two things together make the reading trustworthy:

1. `waitForRowData()` waits for the `.../worksheet/N/rows/...` response, and must
   be subscribed to *before* the action that triggers it (the navigation, or the
   frequency change).
2. `settledPopulatedCellCountForDate()` treats the two outcomes asymmetrically.
   Cells never un-populate, so any non-zero count is conclusive immediately,
   while a zero is only believed once it has held for a full 15-second window.
   Polling for two *equal* consecutive readings — the obvious approach — is
   wrong here, because it settles on the leading run of zeros and reintroduces
   exactly the false negative it was meant to remove.

Note also that the worksheet number in that URL identifies the frequency, not
the plant: `worksheet/4` is Daily and `worksheet/1` is 15 Minute.

**RTC load-test plants: the seeded data is sparse and appears to have stopped.**
Under `RtcLpt-Root-2026-08-26 17:23:03Z`, coverage differs per plant and per
frequency, so a failing operation here is more likely a gap in the seeding job
than a bug in the app. Two observations worth carrying forward:

- Reading a plant's whole Daily month shows values on **one day only** rather
  than every day, and the 15 Minute worksheet that carried values in early
  September now reads zero for every closed slot. Whatever produces this data
  does not appear to be running continuously.
- Because of that, the pass/fail split moves as the fixtures age. Treat the
  numbers in any given run as a snapshot, not as the expected shape, and confirm
  with the fixture owners before reading a failure as a product defect.

Earlier `RtcLpt-Root-*` tenants sampled by `tests/full/rtc-plant-data.spec.ts`
were empty on both frequencies.

Also unexplained: the worksheet exposes only nine parameters when the operation
is named for 3000. The RTC parameters do not appear in the default worksheet
view, so if their data is meant to be read somewhere else, these tests are
looking in the wrong place and should be pointed at that surface instead.

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
