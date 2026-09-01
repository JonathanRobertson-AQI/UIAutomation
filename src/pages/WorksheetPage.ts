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
}
