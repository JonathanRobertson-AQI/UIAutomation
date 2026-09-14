import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Sample Manager: the weekly schedule board, the per-sample "Enter sample
 * results" dialog, and the "Enter results by test" dialog.
 *
 * Both result-entry surfaces are ag-Grid tables whose `result` column is
 * edited in place. The interesting difference between them - and the whole
 * point of AQI-11578 - is *which* editor that column opens:
 *
 * - Enter sample results registers `aqi-analyte-result-cell-editor`, which
 *   renders `aqi-custom-observation-select` (a `mat-autocomplete`) when the
 *   analyte twin resolves to a Rio parameter carrying custom observations.
 * - Enter results by test is expected to do the same.
 *
 * Note on reading cell text: ag-Grid renders the value inside a `<span>`, and
 * `innerText` collapses runs of whitespace the way CSS does. Anything that
 * asserts on verbatim round-tripping must read `textContent` instead, or a
 * value saved with two consecutive spaces will look like it was mangled when
 * in fact only its *rendering* collapsed.
 */
export class SampleManagerPage {
  constructor(private readonly page: Page) {}

  // ---------------------------------------------------------------- routing

  /**
   * Open a plant's Sample Manager schedule board.
   *
   * The board renders progressively: the shell paints, then the week's
   * activities stream in. `waitForScheduleReady` is what makes a click safe.
   */
  async gotoSchedule(plantId: string): Promise<void> {
    await this.page.goto(`./plant/${plantId}/schedule`, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForScheduleReady();
  }

  async waitForScheduleReady(): Promise<void> {
    await expect(
      this.page.getByText('Enter results by test', { exact: true }).first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(this.activityCards.first()).toBeVisible({ timeout: 90_000 });
  }

  /** Every sample/test tile on the visible week. */
  get activityCards(): Locator {
    return this.page.locator('.activity-card');
  }

  /** The topmost Material dialog. */
  get dialog(): Locator {
    return this.page.locator('mat-dialog-container').last();
  }

  // ------------------------------------------------- enter results by test

  /**
   * Open "Enter results by test" and pick an analyte from the left-hand tree.
   *
   * The dialog opens on an empty state ("To begin, select the analytes...");
   * the grid only exists once an analyte is selected, so both steps happen
   * together and the caller always gets a populated table back.
   */
  async openEnterResultsByTest(analyteName: string): Promise<Locator> {
    await this.page
      .getByText('Enter results by test', { exact: true })
      .first()
      .click({ timeout: 60_000 });

    const dialog = this.dialog;
    await expect(dialog.getByText('Select analyte type')).toBeVisible({
      timeout: 60_000,
    });

    await dialog.getByText(analyteName, { exact: false }).first().click();
    await expect(this.gridRows.first()).toBeVisible({ timeout: 60_000 });
    return dialog;
  }

  get gridRows(): Locator {
    return this.page.locator('.ag-center-cols-container .ag-row');
  }

  /** A cell in the by-test grid, by row index and ag-Grid column id. */
  cell(rowIndex: number, colId: string): Locator {
    return this.page
      .locator(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"]`)
      .locator(`.ag-cell[col-id="${colId}"]`)
      .first();
  }

  resultCell(rowIndex = 0): Locator {
    return this.cell(rowIndex, 'result');
  }

  /**
   * Row indices in the by-test grid, newest first.
   *
   * This screen shows one row per *sample* in the test, and those rows are
   * scheduled data: how many exist depends on the operation's schedule on the
   * day the suite runs. Anything asserting on a specific row has to look the
   * row up rather than assume index 0 is the only one.
   */
  async rowIndices(): Promise<string[]> {
    await expect(this.gridRows.first()).toBeVisible({ timeout: 60_000 });
    return this.gridRows.evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('row-index') ?? ''),
    );
  }

  /** Persist the by-test dialog and wait for it to close. */
  async saveByTest(): Promise<void> {
    await this.dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(this.page.locator('mat-dialog-container')).toHaveCount(0, {
      timeout: 90_000,
    });
  }

  // --------------------------------------------------- enter sample results

  /**
   * Open a sample tile, which is the "Enter sample results" surface.
   *
   * The board shows one week at a time, so a sample scheduled earlier is
   * simply absent from the DOM rather than hidden - this steps back through
   * previous weeks until it finds the tile. Without that the sample-based
   * tests quietly start failing the moment the week rolls over, which is a
   * calendar accident rather than a regression.
   *
   * Submitted samples open read-only, so this unlocks them when it has to.
   * That is a real mutation of the sample's status - these tests are in the
   * `full` project for exactly that reason and must not run against prod.
   */
  async openSample(sampleName: string, weeksToSearch = 6): Promise<Locator> {
    const card = this.activityCards.filter({ hasText: sampleName }).first();

    for (let week = 0; week < weeksToSearch; week++) {
      if (await card.count()) break;
      if (week === weeksToSearch - 1) {
        throw new Error(
          `Sample "${sampleName}" was not on the schedule board in the last ` +
            `${weeksToSearch} weeks. Set SAMPLE_MANAGER_SAMPLE_NAME to a ` +
            `sample that exists on this operation.`,
        );
      }
      await this.previousWeek();
    }

    await card.click({ timeout: 60_000 });

    const dialog = this.dialog;
    await expect(dialog.getByText('Analyte name').first()).toBeVisible({
      timeout: 60_000,
    });

    const unlock = dialog.getByText('Unsubmit and unlock', { exact: false });
    if (await unlock.count()) {
      await unlock.first().click();
      await expect(unlock).toHaveCount(0, { timeout: 60_000 });
    }
    return dialog;
  }

  /** Step the schedule board back one week and wait for it to re-render. */
  async previousWeek(): Promise<void> {
    const before = await this.weekRange();

    await this.page
      .getByText('chevron_left', { exact: true })
      .last()
      .click({ timeout: 30_000 });

    // Anchor on the week label, not on the tiles. Every week on this board
    // opens with the same recurring "Test / Influent ABC" tiles, so comparing
    // card text can report "changed" or "unchanged" entirely by accident.
    await expect
      .poll(() => this.weekRange(), { timeout: 30_000 })
      .not.toBe(before);
    await this.page.waitForTimeout(1_000);
  }

  /** The board's current week label, e.g. "Sep 13 - Sep 19". */
  async weekRange(): Promise<string> {
    const label = this.page.locator('.date-range').first();
    await expect(label).toBeVisible({ timeout: 30_000 });
    return (await label.innerText()).trim();
  }

  /**
   * The Result cell for a named analyte inside the sample dialog.
   *
   * The analyte name lives in a pinned-left column and the result in the
   * scrolling centre container, so the two are in *different* DOM subtrees
   * and can only be tied together through the shared `row-index`.
   */
  async sampleResultCell(
    dialog: Locator,
    analyteName: string,
  ): Promise<Locator> {
    const nameCell = dialog
      .locator('.ag-cell[col-id="name"]')
      .filter({ hasText: analyteName })
      .first();
    await expect(nameCell).toBeVisible({ timeout: 60_000 });

    const rowIndex = await nameCell.evaluate((el) =>
      el.closest('.ag-row')!.getAttribute('row-index'),
    );
    return dialog
      .locator(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"]`)
      .locator('.ag-cell[col-id="result"]')
      .first();
  }

  // ------------------------------------------------------------- editing

  /** Open a cell's editor and return its input. */
  async openEditor(cell: Locator): Promise<Locator> {
    await cell.click();
    const input = cell.locator('input').first();
    // The by-test grid sets `singleClickEdit`, the sample dialog does not, so
    // fall back to a double click rather than assuming either behaviour.
    if (!(await input.count())) {
      await cell.dblclick();
    }
    await expect(input).toBeVisible({ timeout: 30_000 });
    return input;
  }

  /**
   * Close whatever editor is open and wait for the cell to render its value.
   *
   * This matters more than it looks. While the custom-observation editor is
   * open the cell's `textContent` is the *editor's* DOM, whose only text node
   * is the `arrow_drop_down` ligature on the trailing `mat-icon` - so reading
   * a cell mid-edit silently yields "arrow_drop_down" instead of the value.
   * Every assertion on a committed value must go through here first.
   *
   * Tab rather than a click on a neutral cell: the by-test grid lives inside a
   * Material dialog whose backdrop and button bar sit above the grid, so a
   * synthetic click intermittently lands on those instead of the cell. Tab
   * also beats Escape, which *cancels* the edit and would mask a genuine
   * commit failure.
   */
  async commitEditor(cell: Locator): Promise<void> {
    await this.page.keyboard.press('Tab');
    await expect(cell.locator('input')).toHaveCount(0, { timeout: 30_000 });
  }

  /** True when the open editor is the shared custom-observation autocomplete. */
  async hasCustomObservationEditor(cell: Locator): Promise<boolean> {
    return (
      (await cell.locator('aqi-custom-observation-select').count()) > 0 ||
      (await cell.locator('[class*="custom-observation"]').count()) > 0
    );
  }

  /**
   * Options currently offered by the autocomplete overlay.
   *
   * `mat-autocomplete` renders into a CDK overlay on the document body, so
   * these are deliberately looked up from `page` and not from the cell.
   */
  get options(): Locator {
    return this.page.locator('mat-option');
  }

  /**
   * Type into the editor and return the options the autocomplete settles on.
   *
   * The overlay re-renders on every keystroke, so a single read straight after
   * typing races the last render and intermittently sees an empty list. This
   * waits for two consecutive identical reads instead, which also lets a
   * genuinely empty result set be reported as empty rather than hanging.
   */
  async filterOptions(input: Locator, text: string): Promise<string[]> {
    await input.fill('');
    await input.pressSequentially(text, { delay: 60 });
    return this.settledOptions();
  }

  /** Poll the overlay until its option list stops changing. */
  async settledOptions({ timeout = 15_000 } = {}): Promise<string[]> {
    const deadline = Date.now() + timeout;
    let previous: string | null = null;

    while (Date.now() < deadline) {
      await this.page.waitForTimeout(300);
      const current = JSON.stringify(await this.options.allInnerTexts());
      if (current === previous) return JSON.parse(current) as string[];
      previous = current;
    }
    return JSON.parse(previous ?? '[]') as string[];
  }

  /**
   * Read a cell's value verbatim.
   *
   * `textContent` rather than `innerText`: see the note on this class. Call
   * `commitEditor` first if an editor might still be open.
   */
  async readValue(cell: Locator): Promise<string> {
    return (await cell.evaluate((el) => el.textContent ?? '')).trim();
  }

  /** Open the editor on a single click and assert its input took focus. */
  async openEditorWithSingleClick(cell: Locator): Promise<Locator> {
    await cell.click();
    const input = cell.locator('input').first();
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(input).toBeFocused({ timeout: 15_000 });
    return input;
  }
}
