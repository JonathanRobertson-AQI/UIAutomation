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
   */
  waitForRowData(timeout = 60_000): Promise<unknown> {
    return this.page.waitForResponse(
      (response) =>
        /\/spreadsheet\/v\d+\/.+\/worksheet\/.+\/rows\//i.test(
          new URL(response.url()).pathname,
        ) && response.ok(),
      { timeout },
    );
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

  /**
   * Count the populated cells representing today, once the grid has settled.
   *
   * Rendering lags the data response slightly, so this reads until two
   * consecutive samples agree rather than trusting the first one.
   */
  async settledPopulatedCellCountForToday(
    isDaily: boolean,
    timeout = 15_000,
  ): Promise<number> {
    const deadline = Date.now() + timeout;
    let count = await this.populatedCellCountForToday(isDaily);

    // Values stream into the grid after the row response lands, so an early
    // zero is indistinguishable from a genuinely empty worksheet. Cells never
    // un-populate, which makes any non-zero reading conclusive immediately;
    // only a zero has to be held for the full window before it is believed.
    // Waiting for two equal readings instead would settle on the leading run
    // of zeros and report populated worksheets as empty.
    while (count === 0 && Date.now() < deadline) {
      await this.page.waitForTimeout(500);
      count = await this.populatedCellCountForToday(isDaily);
    }
    return count;
  }

  /**
   * Count the populated cells representing today.
   *
   * On the daily frequency only today's row counts. The intra-day frequencies
   * already scope the whole grid to a single day, so every row is in play.
   */
  async populatedCellCountForToday(isDaily: boolean): Promise<number> {
    if (!isDaily) {
      return this.page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll('.ag-center-cols-container .ag-cell'),
          ).filter((cell) => (cell as HTMLElement).innerText.trim()).length,
      );
    }

    const today = WorksheetPage.formatDate(new Date());
    const rowIndex = await this.rowIndexForDate(today);
    return this.page.evaluate(
      (index) =>
        Array.from(
          document.querySelectorAll(
            `.ag-center-cols-container .ag-row[row-index="${index}"] .ag-cell`,
          ),
        ).filter((cell) => (cell as HTMLElement).innerText.trim()).length,
      rowIndex,
    );
  }
}
