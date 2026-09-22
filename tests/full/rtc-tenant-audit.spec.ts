import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures/test';
import {
  OperationDirectory,
  type Operation,
} from '../../src/data/OperationDirectory';
import { OpsHomePage } from '../../src/pages/OpsHomePage';
import { WorksheetPage } from '../../src/pages/WorksheetPage';

/**
 * The tenant whose operations are audited. Every RTC load-test tenant is named
 * for the moment it was seeded, so this pins one specific seeding run.
 */
const TENANT = process.env.AUDIT_TENANT ?? 'RtcLpt-Root-2026-08-26 17:23:03Z';

/** Only operations whose name starts with this are audited. */
const NAME_PREFIX = process.env.AUDIT_PREFIX ?? 'RTCPlant';

/** Frequencies an operation is checked on. Data on either one counts. */
const FREQUENCIES = ['Daily', '15 Minute'] as const;

/**
 * How many operations to check at once. Each one costs a full app load — the
 * SPA refetches the whole operation hierarchy every time — so this is what
 * keeps a 150-operation audit to minutes rather than an hour. Pushing it much
 * higher starts timing out those boots rather than going faster.
 */
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY ?? 3);

/** Cap the audit while developing. Unset means "every operation found". */
const LIMIT = Number(process.env.AUDIT_LIMIT ?? 0);

const OUTCOME_LABEL = {
  data: 'DATA      ',
  empty: 'NO DATA   ',
  unreadable: 'UNREADABLE',
} as const;

interface Reading {
  frequency: string;
  /** The period the grid was showing, e.g. `September 2026` or `Sep 1, 2026`. */
  period: string;
  /** The date or slot range the reading covers, for the report. */
  target: string;
  populatedCells: number;
}

/**
 * `unreadable` is deliberately distinct from `empty`. A plant we failed to load
 * tells us nothing about whether it has data, and reporting that as "no data"
 * would be a false accusation against the seeding job.
 */
type Outcome = 'data' | 'empty' | 'unreadable';

interface AuditResult {
  operation: Operation;
  url: string;
  outcome: Outcome;
  readings: Reading[];
  error?: string;
}

/** How many times to try an operation before calling it unreadable. */
const ATTEMPTS = 3;

/**
 * Rebuild a lane's browser after this many operations, to cap the memory each
 * one accumulates across repeated SPA boots.
 *
 * Recycling the *page* is not enough. Much of what a boot allocates is held by
 * the browser process rather than the page, so closing pages alone lets a run
 * climb until the process is killed and every remaining lane dies with it. The
 * whole browser is therefore torn down, which is the only thing that reliably
 * hands the memory back to the OS.
 */
const RECYCLE_AFTER = 10;

/**
 * Read one operation's worksheets and count the cells that should hold values.
 *
 * The two frequencies are checked against different dates, because they become
 * complete at different times:
 *
 * - **Daily** is an aggregate of a whole day's inputs, so it cannot be complete
 *   until the day is over. It is checked against *yesterday*; today's row being
 *   empty is expected, not a finding.
 * - **15 Minute** is checked against *today*, but only for slots that have
 *   closed and had time to settle. The slot in progress, and the one that just
 *   ended, are legitimately empty.
 */
async function readOperation(
  page: Page,
  operation: Operation,
  now = new Date(),
): Promise<Reading[]> {
  const opsHome = new OpsHomePage(page);
  const worksheet = new WorksheetPage(page);
  const readings: Reading[] = [];

  // The grid draws its rows and columns from the worksheet definition, which
  // lands well before the values do — by up to fifteen seconds on a loaded
  // server. Subscribing before navigating, and waiting for the values before
  // counting, is what stops a populated worksheet being reported as empty.
  const dailyLoaded = worksheet.waitForRowData();
  await opsHome.gotoOperationWorksheet(operation.twinReferenceId);
  await worksheet.waitForReady();
  await dailyLoaded;

  for (const frequency of FREQUENCIES) {
    if (frequency !== 'Daily') {
      const loaded = worksheet.waitForRowData();
      await worksheet.selectFrequency(frequency);
      await loaded;
    }

    if (frequency === 'Daily') {
      const yesterday = WorksheetPage.yesterday(now);
      readings.push({
        frequency,
        period: await worksheet.periodLabel(),
        target: WorksheetPage.formatDate(yesterday),
        populatedCells:
          await worksheet.settledPopulatedCellCountForDate(yesterday),
      });
      continue;
    }

    const { populated, expectedSlots } = await worksheet.closedSlotReading(now);
    const cutoff = WorksheetPage.latestExpectedSlotStart(now);
    readings.push({
      frequency,
      period: await worksheet.periodLabel(),
      target:
        `${expectedSlots} slot(s) up to ` +
        cutoff.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        }),
      populatedCells: populated,
    });
  }
  return readings;
}

/**
 * Check a single operation, retrying transient failures.
 *
 * The app's post-load redirect chain can tear down the page mid-read, so a
 * first-attempt failure is more often a flake than a real finding. A page that
 * has actually died cannot recover on its own, so `renew` is used to replace it
 * between attempts. Failures are captured rather than thrown so one bad
 * operation cannot hide the other 149.
 */
async function auditOperation(
  getPage: () => Page,
  renew: () => Promise<void>,
  operation: Operation,
  baseURL: string,
): Promise<AuditResult> {
  const url = new URL(
    `plant/${operation.twinReferenceId}/worksheet`,
    baseURL,
  ).toString();
  let lastError = '';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const readings = await readOperation(getPage(), operation);
      return {
        operation,
        url,
        readings,
        outcome: readings.some((reading) => reading.populatedCells > 0)
          ? 'data'
          : 'empty',
      };
    } catch (error) {
      lastError = (error as Error).message.split('\n')[0];
      if (attempt < ATTEMPTS) {
        // Rebuilding a lane launches a browser, which can itself fail when the
        // machine is under load. That must not abort the audit: this lane's
        // operation is simply unreadable, and the run continues.
        try {
          await renew();
        } catch (renewError) {
          lastError =
            `${lastError} (lane could not be rebuilt: ` +
            `${(renewError as Error).message.split('\n')[0]})`;
          break;
        }
      }
    }
  }

  return { operation, url, readings: [], outcome: 'unreadable', error: lastError };
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 *
 * `slot` identifies the worker rather than the item, so callers can hand each
 * concurrent lane its own resources. Keying off the item index instead would
 * let two lanes collide on the same page.
 */
async function inParallel<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number, slot: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async (_, slot) => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index, slot);
      }
    }),
  );
  return results;
}

function buildReport(results: AuditResult[], generatedAt: Date): string {
  const of = (outcome: Outcome) =>
    results.filter((result) => result.outcome === outcome);
  const withData = of('data');
  const empty = of('empty');
  const unreadable = of('unreadable');

  const row = (result: AuditResult) => {
    const counts = result.error
      ? `error: ${result.error}`
      : result.readings
          .map(
            (r) =>
              `${r.frequency} — ${r.target} (grid: ${r.period}): ${r.populatedCells}`,
          )
          .join('<br>');
    return (
      `| ${result.operation.name} | ${result.operation.parentName} | ` +
      `[open](${result.url}) | ${result.outcome === 'data' ? 'Yes' : 'No'} | ${counts} |`
    );
  };

  const table = (rows: AuditResult[], emptyNote: string) =>
    rows.length
      ? [
          '| Operation | Sub-tenant | Link | Has data | Populated cells |',
          '| --- | --- | --- | --- | --- |',
          ...rows.map(row),
        ].join('\n')
      : emptyNote;

  const yesterday = WorksheetPage.yesterday(generatedAt);
  const cutoff = WorksheetPage.latestExpectedSlotStart(generatedAt);

  return [
    '# RTC tenant data audit',
    '',
    `- **Tenant:** ${TENANT}`,
    `- **Name filter:** operations starting with \`${NAME_PREFIX}\``,
    `- **Daily checked against:** ${WorksheetPage.formatDate(yesterday)} ` +
      '(yesterday — a daily aggregate cannot be complete until the day is over)',
    `- **15 Minute checked against:** ${WorksheetPage.formatDate(generatedAt)} ` +
      `(today, slots up to ${cutoff.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })} — later slots have not had time to settle)`,
    `- **Frequencies:** ${FREQUENCIES.join(', ')} (data on either one counts)`,
    `- **Generated:** ${generatedAt.toISOString()}`,
    '',
    '## Summary',
    '',
    '| Result | Count |',
    '| --- | --- |',
    `| Operations checked | ${results.length} |`,
    `| Has data | ${withData.length} |`,
    `| No data | ${empty.length} |`,
    `| Could not be read | ${unreadable.length} |`,
    '',
    `## No data (${empty.length})`,
    '',
    table(empty, '_None — every operation that could be read had data._'),
    '',
    `## Could not be read (${unreadable.length})`,
    '',
    unreadable.length
      ? 'These failed to load after ' +
        `${ATTEMPTS} attempts, so whether they hold data is unknown.\n\n` +
        table(unreadable, '')
      : '_None._',
    '',
    `## Has data (${withData.length})`,
    '',
    table(withData, '_None._'),
    '',
  ].join('\n');
}

// A single run visits 150 operations across several pages. Retaining video and
// traces for that produces gigabytes of artefacts — enough to fill a disk — for
// no diagnostic value, since the report already names every failing operation
// and links straight to it.
test.use({ video: 'off', trace: 'off' });

test.describe('RTC tenant data audit', () => {
  test('every RTC operation under the tenant has data for today', async ({
    page,
    opsHome,
  }, testInfo) => {
    // 150 operations, each needing its own app load, so this runs far beyond
    // any sensible per-test timeout.
    test.setTimeout(60 * 60_000);

    const baseURL = testInfo.project.use.baseURL!;

    // The picker's tree is fetched during boot, so capture it as the app loads.
    const directory = await OperationDirectory.capture(page, () =>
      opsHome.goto(),
    );
    const found = directory.operationsUnder(TENANT, NAME_PREFIX);
    const operations = LIMIT > 0 ? found.slice(0, LIMIT) : found;

    expect(
      operations.length,
      `No operations named "${NAME_PREFIX}*" found under tenant "${TENANT}".`,
    ).toBeGreaterThan(0);

    console.log(
      `Auditing ${operations.length} of ${found.length} operation(s) under ` +
        `"${TENANT}" with ${CONCURRENCY} concurrent page(s)...`,
    );

    // Each lane runs its own browser rather than sharing the fixture's. A lane
    // that dies then takes only itself down, and recycling can release the
    // browser process's memory too, not just the page's. Every lane loads the
    // same saved sign-in, so they share a session without sharing a process.
    const storageState = testInfo.project.use.storageState as string;
    const laneCount = Math.min(CONCURRENCY, operations.length);

    interface Lane {
      browser: Browser;
      context: BrowserContext;
      page: Page;
    }

    const openLane = async (): Promise<Lane> => {
      // Launching can fail transiently when several browsers are being torn
      // down and rebuilt at once, so give it a couple of tries before letting
      // the failure reach the caller.
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const browser = await chromium.launch();
          const laneContext = await browser.newContext({ storageState });
          return {
            browser,
            context: laneContext,
            page: await laneContext.newPage(),
          };
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
        }
      }
      throw lastError;
    };

    const lanes: Lane[] = await Promise.all(
      Array.from({ length: laneCount }, () => openLane()),
    );
    const uses = new Array(lanes.length).fill(0);

    const renew = async (slot: number) => {
      // The replacement is opened before the old lane is discarded, so a failed
      // launch leaves the lane exactly as it was rather than holding a closed
      // browser that every later operation would fail against.
      const replacement = await openLane();
      const previous = lanes[slot];
      lanes[slot] = replacement;
      uses[slot] = 0;
      // Closing the context first lets a healthy browser shut down cleanly;
      // both are best-effort because a crashed lane has nothing left to close.
      await previous.context.close().catch(() => undefined);
      await previous.browser.close().catch(() => undefined);
    };

    let completed = 0;
    let results: AuditResult[];
    try {
      results = await inParallel(
        operations,
        lanes.length,
        async (operation, _index, slot) => {
          // Every navigation re-boots the SPA and refetches several megabytes
          // of hierarchy, and the renderer does not give all of it back. Left
          // alone, a lane dies partway through a 150-operation run, so lanes
          // are rebuilt periodically rather than waiting for that.
          if (uses[slot] >= RECYCLE_AFTER) {
            // A scheduled rebuild that fails is not worth losing the run over;
            // the lane keeps its current browser and tries again next time.
            await renew(slot).catch(() => undefined);
          }
          uses[slot] += 1;

          const result = await auditOperation(
            () => lanes[slot].page,
            () => renew(slot),
            operation,
            baseURL,
          );
          completed += 1;
          console.log(
            `[${String(completed).padStart(3)}/${operations.length}] ` +
              `${OUTCOME_LABEL[result.outcome]} ` +
              `${result.operation.parentName} / ${result.operation.name}` +
              (result.error ? ` (${result.error})` : ''),
          );
          return result;
        },
      );
    } finally {
      await Promise.all(
        lanes.map(async (lane) => {
          await lane.context.close().catch(() => undefined);
          await lane.browser.close().catch(() => undefined);
        }),
      );
    }

    const report = buildReport(results, new Date());
    const reportPath = path.join(
      testInfo.project.outputDir,
      'rtc-tenant-audit.md',
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, report, 'utf8');
    await testInfo.attach('rtc-tenant-audit.md', {
      path: reportPath,
      contentType: 'text/markdown',
    });
    console.log(`\nReport written to ${reportPath}`);

    const withoutData = results.filter((result) => result.outcome !== 'data');
    const describe = (result: AuditResult) =>
      `${result.operation.parentName} / ${result.operation.name} — ${result.url}` +
      (result.error ? ` (unreadable: ${result.error})` : '');

    expect(
      withoutData.length,
      `${withoutData.length} of ${results.length} operation(s) under "${TENANT}" ` +
        `have no data for today ` +
        `(${results.filter((r) => r.outcome === 'empty').length} empty, ` +
        `${results.filter((r) => r.outcome === 'unreadable').length} unreadable).\n` +
        `Full report: ${reportPath}\n  ` +
        withoutData.slice(0, 20).map(describe).join('\n  ') +
        (withoutData.length > 20
          ? `\n  ...and ${withoutData.length - 20} more (see the report).`
          : ''),
    ).toBe(0);
  });
});
