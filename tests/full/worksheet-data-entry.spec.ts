import { expect, test } from '../../src/fixtures/test';
import { WorksheetPage } from '../../src/pages/WorksheetPage';

/**
 * Data-entry coverage for the Spreadsheets worksheet.
 *
 * These tests WRITE REAL DATA and must never run against production. They live
 * outside `tests/smoke` so the prod-safe `smoke` project cannot pick them up.
 *
 * `JR Waste` is a shared test plant. Its default worksheet is a daily sheet
 * with one row per day of the displayed month, and it opens on the current
 * month — so "today" is always present without touching the month picker.
 */
const PLANT = 'JR Waste';
const PARAMETER = 'pH';

/** A plausible pH reading, distinct enough to prove the write round-tripped. */
function randomPh(exclude?: string): string {
  let value = exclude;
  while (value === exclude) {
    value = (6 + Math.random() * 3).toFixed(2);
  }
  return value!;
}

test.describe('worksheet data entry', () => {
  // Serial: these tests write to the same worksheet cell.
  test.describe.configure({ mode: 'serial' });

  test(`records ${PARAMETER} for today and persists it across a reload`, async ({
    page,
    opsHome,
    worksheet,
  }) => {
    const today = WorksheetPage.formatDate(new Date());

    await opsHome.goto();
    const plantId = await opsHome.switchToPlant(PLANT);
    await worksheet.waitForReady();

    const previous = await worksheet.readValue(today, PARAMETER);
    const value = randomPh(previous);

    await worksheet.enterValue(today, PARAMETER, value);

    // `enterValue` waits for the server to acknowledge the row save, so a
    // reload here genuinely re-reads the value from the API rather than
    // replaying what the grid happened to be showing.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await opsHome.waitForAppReady();
    await opsHome.waitForStableUrl();
    await worksheet.waitForReady();

    expect(opsHome.currentPlantId()).toBe(plantId);
    expect(await worksheet.readValue(today, PARAMETER)).toBe(value);
  });
});
