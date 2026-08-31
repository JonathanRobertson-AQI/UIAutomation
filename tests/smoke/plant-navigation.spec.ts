import { test, expect } from '../../src/fixtures/test';
import { GUID_PATTERN } from '../../src/pages/OpsHomePage';

/**
 * Navigating the plant-scoped sections of the app.
 *
 * These only follow links and assert that each destination renders, so they
 * are safe to run against a published environment.
 */
test.describe('plant navigation @smoke', () => {
  const sections = [
    { name: 'Dashboard', segment: 'dashboard' },
    { name: 'Spreadsheets', segment: 'worksheet' },
    { name: 'Reports', segment: 'reports' },
    { name: 'Graphs', segment: 'graphs' },
    { name: 'Logbook', segment: 'logbook' },
    { name: 'Calendar', segment: 'calendar' },
  ];

  for (const { name, segment } of sections) {
    test(`opens ${name}`, async ({ opsHome }) => {
      await opsHome.goto();
      const plantId = await opsHome.waitForPlantContext();

      const path = await opsHome.openSection(name);

      // Some sections redirect to a deeper default route, so match the prefix.
      expect(path).toMatch(
        new RegExp(`^/ops/plant/${plantId}/${segment}(/|$)`),
      );
      await expect(opsHome.toolbar).toBeVisible();
    });
  }

  test('keeps the same plant context while navigating', async ({ opsHome }) => {
    await opsHome.goto();
    const plantId = await opsHome.waitForPlantContext();

    await opsHome.openSection('Reports');
    expect(opsHome.currentPlantId()).toBe(plantId);

    await opsHome.openSection('Dashboard');
    expect(opsHome.currentPlantId()).toBe(plantId);
  });

  test('scopes tenant-level sections to a tenant GUID', async ({
    page,
    opsHome,
  }) => {
    await opsHome.goto();

    await opsHome.navLink('Organization').click();

    await expect(page).toHaveURL(
      new RegExp(`/tenant/${GUID_PATTERN.source}/organization`, 'i'),
    );
  });
});

