import { expect, test } from '../../src/fixtures/test';

/**
 * Checks that a randomly chosen RTC load-test plant has data recorded for
 * today.
 *
 * These plants are seeded fixtures that exist only on non-production test
 * tenants, which is why this lives outside `tests/smoke`. It reads only.
 *
 * Ten variants exist (`#1` through `#10`), each duplicated across roughly
 * fifteen `RtcLpt*` tenants, so a run picks one of ~150 candidates. The
 * selection is logged as an annotation so a failure names the exact plant.
 */
const PLANT_PREFIX = 'RTCPlant with 3000 RTC params without dashboard';
const VARIANT_COUNT = 10;

/** The frequencies worth checking for a daily reading. */
const FREQUENCIES = ['Daily', '15 Minute'] as const;

test.describe('RTC plant data', () => {
  // Switching operation reloads the whole app context, and each frequency
  // change refetches the worksheet, so this runs well past the default budget.
  test.slow();

  test('a randomly chosen RTC plant has data for today', async ({
    opsHome,
    worksheet,
  }, testInfo) => {
    const variant = 1 + Math.floor(Math.random() * VARIANT_COUNT);
    const name = `${PLANT_PREFIX} #${variant}`;

    await opsHome.goto();

    // The same operation name appears under many tenants; pick among those too
    // so runs spread across tenants rather than always hitting the first.
    const { plantId, index, instanceCount } = await opsHome.switchToOperation(
      name,
      (count) => Math.floor(Math.random() * count),
    );
    await worksheet.waitForReady();

    testInfo.annotations.push(
      {
        type: 'plant',
        description: `${name} (instance ${index + 1} of ${instanceCount})`,
      },
      { type: 'plant-id', description: plantId },
    );

    const findings: string[] = [];
    let populated = 0;

    for (const frequency of FREQUENCIES) {
      // The worksheet definition draws the grid long before the values arrive,
      // so counting straight after the frequency change reports a populated
      // worksheet as empty. Subscribe before switching, then wait for the data.
      const loaded = worksheet.waitForRowData();
      await worksheet.selectFrequency(frequency);
      await loaded;

      const count = await worksheet.settledPopulatedCellCountForToday(
        frequency === 'Daily',
      );
      populated += count;

      findings.push(
        `${frequency} (showing ${await worksheet.periodLabel()}): ${count} populated cell(s)`,
      );
    }

    expect(
      populated,
      `No data recorded for today on ${name} (plant ${plantId}).\n  ` +
        findings.join('\n  '),
    ).toBeGreaterThan(0);
  });
});
