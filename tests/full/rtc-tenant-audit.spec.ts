import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
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
 * Replace a lane's page after this many operations, to cap the memory each one
 * accumulates across repeated SPA boots.
 */
const RECYCLE_AFTER = 25;

/** Read one operation's worksheets and count cells dated today. */
async function readOperation(
  page: Page,
  operation: Operation,
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
    const isDaily = frequency === 'Daily';
    if (!isDaily) {
      const loaded = worksheet.waitForRowData();
      await worksheet.selectFrequency(frequency);
      await loaded;
    }

    readings.push({
      frequency,
      period: await worksheet.periodLabel(),
      populatedCells: await worksheet.settledPopulatedCellCountForToday(isDaily),
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
      if (attempt < ATTEMPTS) await renew();
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
          .map((r) => `${r.frequency} (${r.period}): ${r.populatedCells}`)
          .join('<br>');
    return (
      `| ${result.operation.name} | ${result.operation.parentName} | ` +
      `[open](${result.url}) | ${result.outcome === 'data' ? 'Yes' : 'No'} | ${counts} |`
    );
  };

  const table = (rows: AuditResult[], emptyNote: string) =>
    rows.length
      ? [
          '| Operation | Sub-tenant | Link | Has data today | Populated cells |',
          '| --- | --- | --- | --- | --- |',
          ...rows.map(row),
        ].join('\n')
      : emptyNote;

  return [
    '# RTC tenant data audit',
    '',
    `- **Tenant:** ${TENANT}`,
    `- **Name filter:** operations starting with \`${NAME_PREFIX}\``,
    `- **Date checked:** ${WorksheetPage.formatDate(generatedAt)}`,
    `- **Frequencies:** ${FREQUENCIES.join(', ')} (data on either one counts)`,
    `- **Generated:** ${generatedAt.toISOString()}`,
    '',
    '## Summary',
    '',
    '| Result | Count |',
    '| --- | --- |',
    `| Operations checked | ${results.length} |`,
    `| Has data for today | ${withData.length} |`,
    `| No data for today | ${empty.length} |`,
    `| Could not be read | ${unreadable.length} |`,
    '',
    `## No data for today (${empty.length})`,
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
    `## Has data for today (${withData.length})`,
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
    context,
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

    // Reuse the signed-in context so every page shares the same session. Each
    // concurrent lane gets its own page; the fixture page is left out of the
    // pool so every lane's page can be freely recycled.
    const pool = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, operations.length) }, () =>
        context.newPage(),
      ),
    );
    const uses = new Array(pool.length).fill(0);

    const renew = async (slot: number) => {
      await pool[slot].close().catch(() => undefined);
      pool[slot] = await context.newPage();
      uses[slot] = 0;
    };

    let completed = 0;
    let results: AuditResult[];
    try {
      results = await inParallel(
        operations,
        pool.length,
        async (operation, _index, slot) => {
          // Every navigation re-boots the SPA and refetches several megabytes
          // of hierarchy, and the renderer does not give all of it back. Left
          // alone, a page dies partway through a 150-operation run and takes
          // the browser with it, so lanes are replaced periodically.
          if (uses[slot] >= RECYCLE_AFTER) await renew(slot);
          uses[slot] += 1;

          const result = await auditOperation(
            () => pool[slot],
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
        pool.map((extra) => extra.close().catch(() => undefined)),
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
