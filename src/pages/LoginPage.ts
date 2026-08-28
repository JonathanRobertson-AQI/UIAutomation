import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The AQI identity provider sign-in page.
 *
 * The app uses OIDC implicit flow: navigating to the ops SPA redirects to
 * `api-<env>.aquaticinformatics.net/authentication/login`, and after a
 * successful sign-in the IdP redirects back to the SPA with tokens in the
 * URL fragment.
 */
export class LoginPage {
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.usernameInput = page.locator('#username');
    this.passwordInput = page.locator('#password');
    // Scoped to the form so this never matches the Google / Koch ID / SSO
    // buttons, which also contain the text "Sign in".
    this.signInButton = page
      .locator('form')
      .getByRole('button', { name: 'Sign in', exact: true });
    this.heading = page.getByRole('heading', { name: 'Sign in' });
  }

  /** Navigate to the app, which redirects to the IdP when signed out. */
  async goto(): Promise<void> {
    await this.page.goto('./');
    await this.waitUntilReady();
  }

  async waitUntilReady(): Promise<void> {
    await expect(this.usernameInput).toBeVisible({ timeout: 30_000 });
    await expect(this.passwordInput).toBeVisible();
  }

  /** Sign in and wait until the SPA has loaded after the OIDC redirect. */
  async login(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.signInButton.click();

    // Wait to land back on the ops SPA rather than the identity provider.
    await this.page.waitForURL(/\/ops\//, { timeout: 60_000 });
    await this.page.waitForLoadState('networkidle');
  }

  /** Error banner shown when credentials are rejected. */
  get errorMessage(): Locator {
    return this.page.getByRole('alert');
  }
}
