import { expect, test } from '../../src/fixtures/test';
import { env } from '../../src/config/env';

/**
 * AQI-11578 - VOC: Sample Manager: custom observation dropdown on
 * "Enter results by test".
 *
 * Spec: Confluence "Specification 05", under epic A04 "Sample Manager: Add
 * Text Parameter". The criterion under test is the epic's §3.1 user story 3:
 *
 *   In "Enter results by test" form/table, the "Result" property is updated to
 *   show a dropdown list if the analyte/location is associated with a Rio
 *   custom observation.
 *
 * These tests WRITE REAL DATA and unsubmit samples, so they live in `full`
 * and must never be pointed at production.
 *
 * Serial, because every test drives the same analyte on the same sample.
 */
const { plantId, textAnalyte, sampleName, customObservation } =
  env.sampleManager;

test.describe('AQI-11578 custom observation dropdown', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ sampleManager }) => {
    await sampleManager.gotoSchedule(plantId);
  });

  // ------------------------------------------------------------------------
  // The criterion this ticket delivers.
  // ------------------------------------------------------------------------

  /**
   * The criterion AQI-11578 delivers. Confirmed live on feature-us on
   * 14 Sep 2026: the column now registers `aqi-analyte-result-cell-editor`,
   * which renders `aqi-custom-observation-select`.
   */
  test(`the Result cell offers a custom observation dropdown`, async ({
    sampleManager,
  }) => {
    await sampleManager.openEnterResultsByTest(textAnalyte);

    const cell = sampleManager.resultCell(0);
    const input = await sampleManager.openEditor(cell);
    await input.fill('');

    expect(
      await sampleManager.hasCustomObservationEditor(cell),
      'the by-test Result column should open the shared custom-observation editor',
    ).toBe(true);

    await expect(sampleManager.options.first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await sampleManager.options.allInnerTexts()).toContain(
      customObservation,
    );
  });

  /**
   * Spec task 8. This grid sets `singleClickEdit: true`, which the Enter
   * sample results grid does not, so the editor has to open and take focus on
   * the very first click without the overlay immediately dismissing itself.
   */
  test('the editor opens and takes focus on a single click', async ({
    sampleManager,
  }) => {
    await sampleManager.openEnterResultsByTest(textAnalyte);

    const cell = sampleManager.resultCell(0);
    const input = await sampleManager.openEditorWithSingleClick(cell);

    expect(await sampleManager.hasCustomObservationEditor(cell)).toBe(true);
    await input.fill('');
    await expect(sampleManager.options.first()).toBeVisible({
      timeout: 15_000,
    });
  });

  /**
   * Spec task 7, the headline trap.
   *
   * `gridOptions` sets `stopEditingWhenCellsLoseFocus: true`, and the
   * `mat-autocomplete` panel renders in a CDK overlay on the document body -
   * outside the ag-Grid cell. A mouse click on an option can therefore read as
   * the cell losing focus, making ag-Grid stop editing and discard the pick
   * before it commits. Keyboard selection never leaves the cell, so it cannot
   * catch this; the mouse path has to be exercised explicitly.
   *
   * The cell is seeded with a distinct off-list value first, so a discarded
   * selection shows up as the seed rather than as a coincidental match.
   */
  test('an option chosen with the mouse survives the overlay closing', async ({
    sampleManager,
  }) => {
    const seed = `Seed ${Date.now() % 100000}`;

    await sampleManager.openEnterResultsByTest(textAnalyte);
    const cell = sampleManager.resultCell(0);

    const seedInput = await sampleManager.openEditor(cell);
    await seedInput.fill(seed);
    await sampleManager.commitEditor(cell);
    expect(await sampleManager.readValue(cell)).toBe(seed);

    const input = await sampleManager.openEditor(cell);
    await input.fill('');
    await expect(sampleManager.options.first()).toBeVisible({
      timeout: 15_000,
    });
    await sampleManager.options.first().click();
    await sampleManager.commitEditor(cell);

    expect(
      await sampleManager.readValue(cell),
      'the mouse-selected option was discarded when the overlay closed',
    ).toBe(customObservation);

    await sampleManager.saveByTest();
    await sampleManager.gotoSchedule(plantId);
    await sampleManager.openEnterResultsByTest(textAnalyte);

    expect(await sampleManager.readValue(sampleManager.resultCell(0))).toBe(
      customObservation,
    );
  });

  test('an option chosen with the keyboard commits and saves', async ({
    page,
    sampleManager,
  }) => {
    const seed = `Seed ${Date.now() % 100000}`;

    await sampleManager.openEnterResultsByTest(textAnalyte);
    const cell = sampleManager.resultCell(0);

    const seedInput = await sampleManager.openEditor(cell);
    await seedInput.fill(seed);
    await sampleManager.commitEditor(cell);

    const input = await sampleManager.openEditor(cell);
    await input.fill('');
    await expect(sampleManager.options.first()).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sampleManager.commitEditor(cell);

    expect(await sampleManager.readValue(cell)).toBe(customObservation);

    await sampleManager.saveByTest();
    await sampleManager.gotoSchedule(plantId);
    await sampleManager.openEnterResultsByTest(textAnalyte);

    expect(await sampleManager.readValue(sampleManager.resultCell(0))).toBe(
      customObservation,
    );
  });

  /**
   * "No row picks up another row's value."
   *
   * This screen renders one row per sample in the test, and the same analyte
   * twin repeats across all of them. The spec's guidance resolves valid values
   * once per *distinct* twin and fans the result out, which is exactly the
   * shape of change that can leak one row's edit into its siblings. Skipped
   * when the schedule only produced a single row.
   */
  test('values on sibling rows stay independent', async ({ sampleManager }) => {
    await sampleManager.openEnterResultsByTest(textAnalyte);

    const rows = await sampleManager.rowIndices();
    test.skip(rows.length < 2, 'needs a test with at least two samples');

    const values = rows.map(
      (_, i) => `Row${i} ${Date.now() % 100000}`,
    );

    for (const [i, rowIndex] of rows.entries()) {
      const cell = sampleManager.cell(Number(rowIndex), 'result');
      const input = await sampleManager.openEditor(cell);
      await input.fill(values[i]);
      await sampleManager.commitEditor(cell);
    }

    await sampleManager.saveByTest();
    await sampleManager.gotoSchedule(plantId);
    await sampleManager.openEnterResultsByTest(textAnalyte);

    for (const [i, rowIndex] of rows.entries()) {
      expect(
        await sampleManager.readValue(
          sampleManager.cell(Number(rowIndex), 'result'),
        ),
        `row ${rowIndex} should keep its own value`,
      ).toBe(values[i]);
    }
  });

  // ------------------------------------------------------------------------
  // Cross-screen reference behaviour. Enter sample results already shipped the
  // dropdown, so this is both a regression guard and the baseline the by-test
  // screen has to match.
  // ------------------------------------------------------------------------

  test('Enter sample results lists exactly the configured observations', async ({
    sampleManager,
  }) => {
    const dialog = await sampleManager.openSample(sampleName);
    const cell = await sampleManager.sampleResultCell(dialog, textAnalyte);

    const input = await sampleManager.openEditor(cell);
    expect(await sampleManager.hasCustomObservationEditor(cell)).toBe(true);

    await input.fill('');
    await expect(sampleManager.options.first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await sampleManager.settledOptions()).toEqual([customObservation]);
  });

  test('the option list filters by case-insensitive substring', async ({
    sampleManager,
  }) => {
    const dialog = await sampleManager.openSample(sampleName);
    const cell = await sampleManager.sampleResultCell(dialog, textAnalyte);
    const input = await sampleManager.openEditor(cell);

    // A leading fragment, and a mid-word fragment in the wrong case. Both
    // must match - a `startsWith` or case-sensitive filter fails the second.
    const lead = customObservation.slice(0, 3).toLowerCase();
    const middle = customObservation.slice(2, 5).toUpperCase();

    expect(await sampleManager.filterOptions(input, lead)).toContain(
      customObservation,
    );
    expect(await sampleManager.filterOptions(input, middle)).toContain(
      customObservation,
    );
  });

  test('a value typed in the wrong case is stored in its canonical casing', async ({
    sampleManager,
  }) => {
    const dialog = await sampleManager.openSample(sampleName);
    const cell = await sampleManager.sampleResultCell(dialog, textAnalyte);

    const input = await sampleManager.openEditor(cell);
    await input.fill(customObservation.toLowerCase());
    await input.press('Enter');
    await sampleManager.commitEditor(cell);

    await expect
      .poll(() => sampleManager.readValue(cell), { timeout: 15_000 })
      .toBe(customObservation);
  });

  // ------------------------------------------------------------------------
  // The free-text path, which this screen already delivered and which the
  // dropdown must not regress.
  // ------------------------------------------------------------------------

  test('free text saves verbatim and survives a reload', async ({
    sampleManager,
  }) => {
    // Mixed case plus a double space: the two things a naive normalise-then-
    // save would quietly destroy.
    const value = `Probe ${Date.now() % 100000}  MiXeD`;

    await sampleManager.openEnterResultsByTest(textAnalyte);
    const cell = sampleManager.resultCell(0);
    const input = await sampleManager.openEditor(cell);
    await input.fill(value);
    await input.press('Enter');
    await sampleManager.commitEditor(cell);
    await sampleManager.saveByTest();

    await sampleManager.gotoSchedule(plantId);
    await sampleManager.openEnterResultsByTest(textAnalyte);

    expect(await sampleManager.readValue(sampleManager.resultCell(0))).toBe(
      value,
    );
  });

  test('free text is rendered as text, not as markup', async ({
    page,
    sampleManager,
  }) => {
    const payload = `<img src=x onerror=alert(1)> ${Date.now() % 100000}`;

    // If the payload were ever injected as markup, `onerror` would fire and
    // this would catch the resulting dialog rather than letting it hang.
    const alerts: string[] = [];
    page.on('dialog', async (d) => {
      alerts.push(d.message());
      await d.dismiss();
    });

    await sampleManager.openEnterResultsByTest(textAnalyte);
    const cell = sampleManager.resultCell(0);
    const input = await sampleManager.openEditor(cell);
    await input.fill(payload);
    await input.press('Enter');
    await sampleManager.commitEditor(cell);
    await sampleManager.saveByTest();

    await sampleManager.gotoSchedule(plantId);
    await sampleManager.openEnterResultsByTest(textAnalyte);

    const reloaded = sampleManager.resultCell(0);
    expect(await sampleManager.readValue(reloaded)).toBe(payload);
    // The payload must have been escaped, so no element was ever created.
    expect(await reloaded.locator('img').count()).toBe(0);
    expect(alerts).toEqual([]);
  });

  test('no limit colouring or out-of-range styling is applied to a text result', async ({
    sampleManager,
  }) => {
    await sampleManager.openEnterResultsByTest(textAnalyte);
    const cell = sampleManager.resultCell(0);

    const className = await cell.getAttribute('class');
    expect(className ?? '').not.toMatch(/goal|warning|regulatory|out-of-range/i);
  });

  // ------------------------------------------------------------------------
  // Consistency between the two screens, in both directions.
  // ------------------------------------------------------------------------

  test('a value entered by test is shown on Enter sample results', async ({
    sampleManager,
  }) => {
    const value = `Crossed ${Date.now() % 100000}`;

    await sampleManager.openEnterResultsByTest(textAnalyte);
    const byTestCell = sampleManager.resultCell(0);
    const input = await sampleManager.openEditor(byTestCell);
    await input.fill(value);
    await input.press('Enter');
    await sampleManager.commitEditor(byTestCell);
    await sampleManager.saveByTest();

    await sampleManager.gotoSchedule(plantId);
    const dialog = await sampleManager.openSample(sampleName);
    const sampleCell = await sampleManager.sampleResultCell(
      dialog,
      textAnalyte,
    );

    expect(await sampleManager.readValue(sampleCell)).toBe(value);
  });
});
