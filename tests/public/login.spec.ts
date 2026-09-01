import { test, expect } from '../../src/fixtures/test';

/**
 * Read-only checks against the sign-in page itself. These run signed out, so
 * they override the stored authentication state.
 */
test.describe('sign-in page @smoke', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects an anonymous visitor to the identity provider', async ({
    page,
    loginPage,
  }) => {
    await loginPage.goto();

    expect(page.url()).toContain('/authentication/login');
    await expect(loginPage.heading).toBeVisible();
  });

  test('presents the username and password fields', async ({ loginPage }) => {
    await loginPage.goto();

    await expect(loginPage.usernameInput).toBeVisible();
    await expect(loginPage.passwordInput).toBeVisible();
    await expect(loginPage.signInButton).toBeEnabled();
  });

  test('offers the federated sign-in options', async ({ page, loginPage }) => {
    await loginPage.goto();

    await expect(page.getByRole('button', { name: /Sign in with SSO/i })).toBeVisible();
  });
});
