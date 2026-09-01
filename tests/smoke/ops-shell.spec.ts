import { test, expect } from '../../src/fixtures/test';
import { GUID_PATTERN } from '../../src/pages/OpsHomePage';

/**
 * Read-only checks against the authenticated application shell.
 *
 * Nothing here creates, edits or deletes data, so this file is safe to run
 * against a published environment.
 */
test.describe('ops application shell @smoke', () => {
  test('loads the app for an authenticated user', async ({ page, opsHome }) => {
    await opsHome.goto();

    await expect(page).toHaveURL(/\/ops\//);
    await expect(opsHome.toolbar).toBeVisible();
    expect(await opsHome.isOnLoginPage()).toBe(false);
  });

  test('restores a plant context on sign-in', async ({ opsHome }) => {
    await opsHome.goto();

    // The app returns the user to their last context, which is plant scoped.
    const plantId = await opsHome.waitForPlantContext();
    expect(plantId).toMatch(GUID_PATTERN);
  });

  test('renders the primary navigation', async ({ opsHome }) => {
    await opsHome.goto();

    for (const section of ['Dashboard', 'Spreadsheets', 'Reports', 'Graphs']) {
      await expect(
        opsHome.navLink(section),
        `Expected a "${section}" navigation link`,
      ).toBeVisible();
    }
  });

  /**
   * Console messages that appear intermittently on load and are not worth
   * failing a smoke run over.
   *
   * `Failed to login` shows up sporadically when the app is restoring a
   * session, without any visible impact — the app still loads and works.
   * Worth investigating separately; see the notes in README.md.
   */
  const IGNORED_CONSOLE_ERRORS = [/Failed to login/i];

  test('loads without unexpected console errors', async ({ page, opsHome }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE_ERRORS.some((pattern) => pattern.test(text))) return;
      errors.push(text);
    });

    await opsHome.goto();

    expect(errors, `Console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('loads without failed network requests', async ({ page, opsHome }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failures.push(`${response.status()} ${response.url()}`);
      }
    });

    await opsHome.goto();

    expect(failures, `Failed requests:\n${failures.join('\n')}`).toEqual([]);
  });
});
