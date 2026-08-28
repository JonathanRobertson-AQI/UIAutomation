import { test, expect } from '../../src/fixtures/test';

/**
 * Read-only checks against the authenticated application shell.
 *
 * Nothing here creates, edits or deletes data, so this file is safe to run
 * against a published environment.
 */
test.describe('ops application shell @smoke', () => {
  test('loads the app for an authenticated user', async ({ page, opsHome }) => {
    await opsHome.goto();
    await opsHome.waitForAppReady();

    await expect(page).toHaveURL(/\/ops\//);
    expect(await opsHome.isOnLoginPage()).toBe(false);
  });

  test('renders without console errors', async ({ page, opsHome }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await opsHome.goto();
    await opsHome.waitForAppReady();

    expect(errors, `Console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('returns no failed network requests on load', async ({
    page,
    opsHome,
  }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failures.push(`${response.status()} ${response.url()}`);
      }
    });

    await opsHome.goto();
    await opsHome.waitForAppReady();

    expect(failures, `Failed requests:\n${failures.join('\n')}`).toEqual([]);
  });
});
