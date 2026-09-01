import { test as base, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { OpsHomePage } from '../pages/OpsHomePage';
import { WorksheetPage } from '../pages/WorksheetPage';

type Fixtures = {
  loginPage: LoginPage;
  opsHome: OpsHomePage;
  worksheet: WorksheetPage;
};

/**
 * Shared test fixtures.
 *
 * Import `test` and `expect` from here rather than from `@playwright/test`
 * so every test gets the page objects for free.
 */
export const test = base.extend<Fixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  opsHome: async ({ page }, use) => {
    await use(new OpsHomePage(page));
  },

  worksheet: async ({ page }, use) => {
    await use(new WorksheetPage(page));
  },
});

export { expect };
