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
import { RowsApiClient, WORKSHEET_ID } from '../../src/api/RowsApiClient';

/**
 * API-only counterpart to `rtc-tenant-audit.spec.ts`.
 *
 * The DOM-based audit waits for the full worksheet grid to render and
 * virtual-scroll through it. Almost all of that is answering one question:
 * does the spreadsheet rows API return any rows for the day in question. This
 * test asks the API that question directly, skipping the grid entirely — the
 * only UI interaction left is the single navigation needed to discover an
 * operation's `viewId` (see `RowsApiClient.watchForViewContext`).
 *
 * Same tenant/prefix/date rules as the DOM audit: Daily is checked against
 * yesterday (a daily aggregate can't be complete until the day is over); 15
 * Minute is checked against today (empty is only meaningful once a slot has
 * had time to settle).
 */
const TENANT = process.env.AUDIT_TENANT ?? 'RtcLpt-Root-2026-08-26 17:23:03Z';

/** Only operations whose name starts with this are audited. */
const NAME_PREFIX = process.env.AUDIT_PREFIX ?? 'RTCPlant';

/**
 * How many operations to check at once. Each still costs one SPA boot (to
 * discover `viewId`), but nothing after that touches the grid, so this can
 * run higher than the DOM audit's concurrency for the same load.
 */
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY ?? 5);

/** Cap the audit while developing. Unset means "every operation found". */
const LIMIT = Number(process.env.AUDIT_LIMIT ?? 0);

const OUTCOME_LABEL = {
  data: 'DATA      ',
  empty: 'NO DATA   ',
  unreadable: 'UNREADABLE',
} as const;

interface Reading {
  frequency: string;
  target: string;
  rowCount: number;
  note?: string;
}

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

/** Rebuild a lane's browser after this many operations (see the DOM audit). */
const RECYCLE_AFTER = 20;

/**
 * Read one operation's Daily and 15 Minute rows directly from the API.
 *
 * A single navigation is still needed — not to render anything, but to let
 * the app make its own first rows request, which is the only place `viewId`
 * comes from (see `RowsApiClient.watchForViewContext`). Everything after that
 * is a direct JSON fetch, no grid involved.
 */
async function readOperation(
  page: Page,
  operation: Operation,
  now = new Date(),
): Promise<Reading[]> {
  const opsHome = new OpsHomePage(page);
  const client = new RowsApiClient(page);

  const context = client.watchForViewContext(operation.twinReferenceId);
  await opsHome.gotoOperationWorksheet(operation.twinReferenceId);
  const viewContext = await context;

  const yesterday = WorksheetPage.yesterday(now);
  const daily = await client.fetchDayRows(viewContext, WORKSHEET_ID.daily, yesterday);

  const cutoff = WorksheetPage.latestExpectedSlotStart(now);
  const aSlotHasSettled = cutoff.toDateString() === now.toDateString();
  const fifteenMinute = await client.fetchDayRows(
    viewContext,
    WORKSHEET_ID.fifteenMinute,
    now,
  );

  return [
    {
      frequency: 'Daily',
      target: WorksheetPage.formatDate(yesterday),
      rowCount: daily.rowNumbers.length,
    },
    {
      frequency: '15 Minute',
      target: WorksheetPage.formatDate(now),
      rowCount: fifteenMinute.rowNumbers.length,
      // Too early in the day for any slot to have settled: an empty result
      // here says nothing, so it must not be read as "no data".
      note: aSlotHasSettled ? undefined : 'no slot has settled yet today',
    },
  ];
}

/** Check a single operation, retrying transient failures (see the DOM audit). */
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
      const hasData = readings.some(
        (reading) => !reading.note && reading.rowCount > 0,
      );
      const anyInconclusive = readings.some(
        (reading) => reading.note && reading.rowCount === 0,
      );
      return {
        operation,
        url,
        readings,
        outcome: hasData ? 'data' : anyInconclusive ? 'unreadable' : 'empty',
      };
    } catch (error) {
      lastError = (error as Error).message.split('\n')[0];
      if (attempt < ATTEMPTS) {
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
              `${r.frequency} — ${r.target}: ${r.rowCount} row(s)` +
              (r.note ? ` (${r.note})` : ''),
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
          '| Operation | Sub-tenant | Link | Has data | Rows |',
          '| --- | --- | --- | --- | --- |',
          ...rows.map(row),
        ].join('\n')
      : emptyNote;

  const yesterday = WorksheetPage.yesterday(generatedAt);

  return [
    '# RTC tenant data audit (API-only)',
    '',
    `- **Tenant:** ${TENANT}`,
    `- **Name filter:** operations starting with \`${NAME_PREFIX}\``,
    `- **Daily checked against:** ${WorksheetPage.formatDate(yesterday)} ` +
      '(yesterday) via `worksheet/4/rows/byday`',
    `- **15 Minute checked against:** ${WorksheetPage.formatDate(generatedAt)} ` +
      '(today) via `worksheet/1/rows/byday`',
    '- **Method:** direct JSON fetch of the spreadsheet rows API ' +
      '(`Accept: application/json`), not the rendered grid.',
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
      ? 'These failed to load, or were checked too early for any 15 Minute ' +
        `slot to have settled, after ${ATTEMPTS} attempt(s).\n\n` +
        table(unreadable, '')
      : '_None._',
    '',
    `## Has data (${withData.length})`,
    '',
    table(withData, '_None._'),
    '',
  ].join('\n');
}

// Same rationale as the DOM audit: no video/trace for a 150-operation run.
test.use({ video: 'off', trace: 'off' });

test.describe('RTC tenant data audit (API-only)', () => {
  test('every RTC operation under the tenant has data for today', async ({
    page,
    opsHome,
  }, testInfo) => {
    test.setTimeout(60 * 60_000);

    const baseURL = testInfo.project.use.baseURL!;

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
        `"${TENANT}" via the API, with ${CONCURRENCY} concurrent page(s)...`,
    );

    const storageState = testInfo.project.use.storageState as string;
    const laneCount = Math.min(CONCURRENCY, operations.length);

    interface Lane {
      browser: Browser;
      context: BrowserContext;
      page: Page;
    }

    const openLane = async (): Promise<Lane> => {
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
      const replacement = await openLane();
      const previous = lanes[slot];
      lanes[slot] = replacement;
      uses[slot] = 0;
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
          if (uses[slot] >= RECYCLE_AFTER) {
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
      'rtc-tenant-audit-api.md',
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, report, 'utf8');
    await testInfo.attach('rtc-tenant-audit-api.md', {
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
