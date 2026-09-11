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
   * Marked `fail` deliberately.
   *
   * As of this run the feature environment serves the plain ag-Grid text
   * editor for the by-test `result` column - `aqi-analyte-result-cell-editor`
   * is not registered on it at all - while the very same analyte does get the
   * autocomplete on Enter sample results. AQI-11578 is still in Code Review,
   * so this is "not deployed yet" rather than a defect in shipped code.
   *
   * Keeping the assertion truthful and annotating it means CI stays green
   * today *and* turns red the moment the feature lands, at which point this
   * annotation is the only line that needs deleting.
   */
  test(`the Result cell offers a custom observation dropdown`, async ({
    sampleManager,
  }) => {
    // Scoped to this test only - a bare `test.fail()` in the describe body
    // would silently invert every assertion in the file.
    test.fail();

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

  // ------------------------------------------------------------------------
  // Cross-screen reference behaviour. Enter sample results already ships the
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
