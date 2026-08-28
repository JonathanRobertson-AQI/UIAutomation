import { test as base, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { OpsHomePage } from '../pages/OpsHomePage';
import { restoreSessionStorage } from './sessionStorage';

type Fixtures = {
  loginPage: LoginPage;
  opsHome: OpsHomePage;
};

/**
 * Shared test fixtures.
 *
 * Import `test` and `expect` from here rather than from `@playwright/test`
 * so every test gets page objects and sessionStorage-based auth for free.
 */
export const test = base.extend<Fixtures>({
  context: async ({ context }, use) => {
    await restoreSessionStorage(context);
    await use(context);
  },

  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  opsHome: async ({ page }, use) => {
    await use(new OpsHomePage(page));
  },
});

export { expect };
