import { expect, type Locator, type Page } from '@playwright/test';

/**
 * A worksheet (Spreadsheets section) in the ops app.
 *
 * The worksheet is an ag-Grid whose rows are dates — one per day of the
 * displayed month — and whose columns are measured parameters, grouped by
 * process area. Dates live in a pinned-left column; the parameter cells are in
 * the scrollable centre container.
 *
 * Column ids are opaque numeric parameter ids that differ per plant, so
 * columns are always resolved by their visible header text.
 */
export class WorksheetPage {
  readonly grid: Locator;

  constructor(private readonly page: Page) {
    this.grid = page.locator('.ag-root').first();
  }

  async waitForReady(): Promise<void> {
    await expect(this.grid).toBeVisible({ timeout: 60_000 });
    await expect(
      this.page.locator('.ag-pinned-left-cols-container .ag-row').first(),
    ).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Format a date the way the worksheet's date column renders it: `M/D/YYYY`
   * with no leading zeros.
   */
  static formatDate(date: Date): string {
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
  }

  /**
   * Resolve a parameter column's id from its header text.
   *
   * Headers read like `pH (su)` or `DO (mg/L)`, so a prefix match on the
   * parameter name is enough and callers don't have to repeat the units.
   */
  async columnId(parameter: string): Promise<string> {
    const colId = await this.page.evaluate((name) => {
      const headers = Array.from(
        document.querySelectorAll('.ag-header-cell[col-id]'),
      );
      const match = headers.find((header) =>
        (header as HTMLElement).innerText.trim().startsWith(name),
      );
      return match?.getAttribute('col-id') ?? null;
    }, parameter);

    if (!colId) {
      throw new Error(`No worksheet column found for parameter "${parameter}"`);
    }
    return colId;
  }

  /**
   * Resolve the grid row index for a date, scrolling the grid until the row is
   * rendered. ag-Grid virtualises rows, so a date late in the month is not in
   * the DOM until it has been scrolled to.
   */
  async rowIndexForDate(date: string): Promise<number> {
    const read = () =>
      this.page.evaluate((wanted) => {
        const rows = Array.from(
          document.querySelectorAll('.ag-pinned-left-cols-container .ag-row'),
        );
        const match = rows.find(
          (row) => (row as HTMLElement).innerText.trim() === wanted,
        );
        const index = match?.getAttribute('row-index');
        return index === null || index === undefined ? null : Number(index);
      }, date);

    const viewport = this.page.locator('.ag-body-viewport').first();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const index = await read();
      if (index !== null) return index;
      await viewport.evaluate((element) => {
        element.scrollTop += element.clientHeight * 0.8;
      });
      await this.page.waitForTimeout(150);
    }

    throw new Error(`No worksheet row found for date ${date}`);
  }

  cell(rowIndex: number, colId: string): Locator {
    return this.page.locator(
      `.ag-center-cols-container .ag-row[row-index="${rowIndex}"] .ag-cell[col-id="${colId}"]`,
    );
  }

  /** Read the rendered value of a parameter on a given date. */
  async readValue(date: string, parameter: string): Promise<string> {
    const [rowIndex, colId] = await Promise.all([
      this.rowIndexForDate(date),
      this.columnId(parameter),
    ]);
    const cell = this.cell(rowIndex, colId);
    await cell.scrollIntoViewIfNeeded();
    return (await cell.innerText()).trim();
  }

  /**
   * Enter a value for a parameter on a given date.
   *
   * The grid has no explicit save: selecting a cell, typing, and pressing Enter
   * commits the edit and the app persists it in the background.
   *
   * The cell renders the new value as soon as it is committed locally, well
   * before the write reaches the server, so waiting on the cell text alone is a
   * race — reloading straight afterwards can discard the edit. This waits for
   * the row-save request to come back successfully instead.
   */
  async enterValue(
    date: string,
    parameter: string,
    value: string,
  ): Promise<void> {
    const [rowIndex, colId] = await Promise.all([
      this.rowIndexForDate(date),
      this.columnId(parameter),
    ]);
    const cell = this.cell(rowIndex, colId);

    await cell.scrollIntoViewIfNeeded();

    // Subscribe before typing so a fast save cannot slip past us.
    const saved = this.waitForSave();

    await cell.click();
    await this.page.keyboard.type(value, { delay: 50 });
    await this.page.keyboard.press('Enter');

    await expect(cell).toHaveText(value, { timeout: 15_000 });
    await saved;
  }

  /**
   * Resolve once the worksheet has persisted a row edit.
   *
   * Saving posts the edited row to the spreadsheet API; a 2xx there is the
   * app's only signal that the value is durable.
   */
  waitForSave(timeout = 30_000): Promise<unknown> {
    return this.page.waitForResponse(
      (response) => {
        const request = response.request();
        return (
          request.method() === 'POST' &&
          /\/spreadsheet\/v\d+\/.+\/worksheet\/.+\/rows$/i.test(
            new URL(response.url()).pathname,
          ) &&
          response.ok()
        );
      },
      { timeout },
    );
  }

  /**
   * The worksheet's sampling frequency, shown as a dropdown in the grid's
   * top-left corner. `Daily` lists one row per day of the month; the intra-day
   * frequencies list time slots for a single day.
   */
  static readonly FREQUENCIES = [
    'Daily',
    '4 Hour',
    'Hourly',
    '15 Minute',
  ] as const;

  /**
   * Switch the worksheet to a different sampling frequency.
   *
   * The menu is retried as a whole. Angular Material re-renders the panel while
   * it animates in, so a click issued the instant the option becomes visible
   * lands on a node that is then detached — Playwright reports it as
   * "element is not stable" and then "element was detached from the DOM".
   * Waiting for the panel to settle first avoids most of that; retrying covers
   * the rest.
   */
  async selectFrequency(frequency: string): Promise<void> {
    const header = this.page.locator('.ag-header-cell[col-id="window"]').first();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await header.click();

        const option = this.page
          .locator(
            '[role="menuitem"], .mat-mdc-menu-item, mat-option, [role="option"]',
          )
          .filter({ hasText: new RegExp(`^\\s*${frequency}\\s*$`) })
          .first();
        await expect(option).toBeVisible({ timeout: 15_000 });
        // Let the open animation finish before clicking into it.
        await this.page.waitForTimeout(400);
        await option.click({ timeout: 10_000 });

        await expect(header).toContainText(frequency, { timeout: 30_000 });
        await this.waitForReady();
        return;
      } catch (error) {
        if (attempt === 3) throw error;
        // Dismiss whatever is left open before trying again.
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(500);
      }
    }
  }

  /**
   * Resolve once the worksheet has loaded its cell values.
   *
   * The grid renders its rows and columns from the worksheet *definition*,
   * which arrives well before the values do. Counting populated cells between
   * those two points reports a fully-populated worksheet as empty, so any read
   * has to wait for this response rather than for the grid to appear.
   *
   * Callers must subscribe *before* the action that triggers the load, which
   * means an action that throws leaves this promise pending and unawaited. It
   * then rejects on its own when the page closes or the timeout expires, and an
   * unhandled rejection fails the entire run rather than the one operation. The
   * no-op handler below marks the promise as handled without consuming the
   * rejection, so callers that do await it still see the error.
   */
  waitForRowData(timeout = 60_000): Promise<unknown> {
    const pending = this.page.waitForResponse(
      (response) =>
        /\/spreadsheet\/v\d+\/.+\/worksheet\/.+\/rows\//i.test(
          new URL(response.url()).pathname,
        ) && response.ok(),
      { timeout },
    );
    pending.catch(() => undefined);
    return pending;
  }

  /**
   * The period the grid is currently showing — `September 2026` on the daily
   * frequency, or a single day such as `Sep 1, 2026` on intra-day ones.
   */
  async periodLabel(): Promise<string> {
    const label = this.page
      .getByText(/^(?:[A-Z][a-z]{2,8} \d{1,2}, \d{4}|[A-Z][a-z]{2,8} \d{4})$/)
      .first();
    return (await label.innerText()).trim();
  }

  /** Length of one slot on the 15 Minute frequency. */
  static readonly SLOT_MINUTES = 15;

  /**
   * How long after a slot closes before its value is expected to appear.
   *
   * Values are written up to roughly a slot-length after the period ends, so a
   * slot that has only just closed being empty is normal rather than a finding.
   */
  static readonly SETTLE_MINUTES = 15;

  /** The most recent slot start that should already have a value. */
  static latestExpectedSlotStart(now = new Date()): Date {
    return new Date(
      now.getTime() -
        (WorksheetPage.SLOT_MINUTES + WorksheetPage.SETTLE_MINUTES) * 60_000,
    );
  }

  /** Yesterday, the most recent day whose daily aggregate can be complete. */
  static yesterday(now = new Date()): Date {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    return date;
  }

  /**
   * Re-read a count until it settles.
   *
   * Values stream into the grid after the row response lands, so an early zero
   * is indistinguishable from a genuinely empty worksheet. Cells never
   * un-populate, which makes any non-zero reading conclusive immediately; only
   * a zero has to be held for the full window before it is believed. Waiting
   * for two equal readings instead would settle on the leading run of zeros
   * and report populated worksheets as empty.
   */
  private async settled(
    read: () => Promise<number>,
    timeout: number,
  ): Promise<number> {
    const deadline = Date.now() + timeout;
    let count = await read();

    while (count === 0 && Date.now() < deadline) {
      await this.page.waitForTimeout(500);
      count = await read();
    }
    return count;
  }

  /**
   * Move the grid back one period — a month on Daily, a day on the intra-day
   * frequencies.
   */
  async showPreviousPeriod(): Promise<void> {
    const loaded = this.waitForRowData().catch(() => undefined);
    await this.page.getByRole('button', { name: 'Previous' }).first().click();
    await loaded;
    await this.waitForReady();
  }

  /**
   * Scroll the daily grid back until it is showing the month containing `date`.
   *
   * Daily lists one row per day of the displayed month, so yesterday is already
   * on screen except on the first of the month, when it belongs to the previous
   * one.
   */
  async ensureMonthShown(date: Date): Promise<void> {
    const wanted = date.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await this.periodLabel()) === wanted) return;
      await this.showPreviousPeriod();
    }

    if ((await this.periodLabel()) !== wanted) {
      throw new Error(
        `Worksheet is showing "${await this.periodLabel()}", expected "${wanted}"`,
      );
    }
  }

  /** Count the populated cells in the daily row for `date`, once settled. */
  async settledPopulatedCellCountForDate(
    date: Date,
    timeout = 15_000,
  ): Promise<number> {
    await this.ensureMonthShown(date);
    const rowIndex = await this.rowIndexForDate(WorksheetPage.formatDate(date));

    return this.settled(
      () =>
        this.page.evaluate(
          (index) =>
            Array.from(
              document.querySelectorAll(
                `.ag-center-cols-container .ag-row[row-index="${index}"] .ag-cell`,
              ),
            ).filter((cell) => (cell as HTMLElement).innerText.trim()).length,
          rowIndex,
        ),
      timeout,
    );
  }

  /**
   * Count populated cells on an intra-day frequency, ignoring slots too recent
   * to have a value yet.
   *
   * The grid holds 96 rows for a day but virtualises them, so only a screenful
   * exists in the DOM at a time. Finding data anywhere is enough to answer
   * "does this have data", so the scan stops at the first populated slot and
   * only pages through the whole day when it has found nothing — which keeps
   * the common case fast without letting a "no data" verdict rest on one
   * screenful.
   */
  async closedSlotReading(
    now = new Date(),
    timeout = 15_000,
  ): Promise<{ populated: number; expectedSlots: number }> {
    const cutoff = WorksheetPage.latestExpectedSlotStart(now);
    const cutoffMinutes = cutoff.getHours() * 60 + cutoff.getMinutes();

    // The grid is scoped to one day; only limit by time when that day is today.
    const showingToday =
      (await this.periodLabel()) ===
      now.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    const limit = showingToday ? cutoffMinutes : 24 * 60;

    const viewport = this.page.locator('.ag-body-viewport').first();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });

    const seen = new Map<number, number>();
    let populated = 0;

    for (let screen = 0; screen < 12; screen += 1) {
      const rows = await this.settledRowScan(limit, timeout, screen === 0);

      for (const row of rows.slots) seen.set(row.minutes, row.populated);
      populated = [...seen.values()].reduce((sum, n) => sum + n, 0);
      if (populated > 0) break;

      const atBottom = await viewport.evaluate((element) => {
        const before = element.scrollTop;
        element.scrollTop += element.clientHeight * 0.8;
        return element.scrollTop === before;
      });
      if (atBottom) break;
      await this.page.waitForTimeout(200);
    }

    const expectedSlots = [...seen.keys()].length;
    return { populated, expectedSlots };
  }

  /**
   * Read the currently rendered intra-day rows, counting only slots at or
   * before `limitMinutes`.
   */
  private async settledRowScan(
    limitMinutes: number,
    timeout: number,
    allowSettle: boolean,
  ): Promise<{ slots: { minutes: number; populated: number }[] }> {
    const read = () =>
      this.page.evaluate((limit) => {
        const toMinutes = (text: string): number | null => {
          const match = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
          if (!match) return null;
          let hours = Number(match[1]);
          const minutes = Number(match[2]);
          const meridiem = match[3]?.toUpperCase();
          if (meridiem === 'PM' && hours !== 12) hours += 12;
          if (meridiem === 'AM' && hours === 12) hours = 0;
          return hours * 60 + minutes;
        };

        const populatedByIndex = new Map<string, number>();
        document
          .querySelectorAll('.ag-center-cols-container .ag-row')
          .forEach((row) => {
            populatedByIndex.set(
              row.getAttribute('row-index') ?? '?',
              Array.from(row.querySelectorAll('.ag-cell')).filter((cell) =>
                (cell as HTMLElement).innerText.trim(),
              ).length,
            );
          });

        const slots: { minutes: number; populated: number }[] = [];
        document
          .querySelectorAll('.ag-pinned-left-cols-container .ag-row')
          .forEach((row) => {
            const minutes = toMinutes((row as HTMLElement).innerText.trim());
            if (minutes === null || minutes > limit) return;
            slots.push({
              minutes,
              populated:
                populatedByIndex.get(row.getAttribute('row-index') ?? '?') ?? 0,
            });
          });
        return { slots };
      }, limitMinutes);

    if (!allowSettle) return read();

    // Only the first screenful waits out the value-load lag; later ones are
    // scrolled into an already-loaded grid.
    const deadline = Date.now() + timeout;
    let result = await read();
    while (
      result.slots.every((slot) => slot.populated === 0) &&
      Date.now() < deadline
    ) {
      await this.page.waitForTimeout(500);
      result = await read();
    }
    return result;
  }
}
