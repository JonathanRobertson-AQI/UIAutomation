import { test as setup, expect } from '@playwright/test';
import { LoginPage } from '../src/pages/LoginPage';
import { OpsHomePage } from '../src/pages/OpsHomePage';
import { saveSessionStorage } from '../src/fixtures/sessionStorage';
import { env, STORAGE_STATE } from '../src/config/env';

/**
 * Runs once before the test projects. Signs in with the credentials from the
 * environment and persists the resulting session so tests don't each pay the
 * cost of a full OIDC round trip.
 *
 * Tokens from an implicit flow are short lived, so this runs on every
 * invocation of the suite rather than being cached between runs.
 */
setup('authenticate', async ({ page }) => {
  setup.setTimeout(120_000);

  const loginPage = new LoginPage(page);
  const opsHome = new OpsHomePage(page);

  await loginPage.goto();
  await loginPage.login(env.username, env.password);

  await expect(page).toHaveURL(/\/ops\//);
  await expect
    .poll(() => opsHome.isOnLoginPage(), {
      message: 'Still on the sign-in page after submitting credentials',
      timeout: 30_000,
    })
    .toBe(false);

  await page.context().storageState({ path: STORAGE_STATE });
  await saveSessionStorage(page);
});
