import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Matches the GUID segments the ops app uses throughout its routes, e.g.
 * `/ops/plant/<guid>/worksheet/4/view/<guid>`.
 */
export const GUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The authenticated ops application shell.
 *
 * Route GUIDs are customer- and environment-specific, so nothing here builds
 * a deep link by hand. Tests navigate by clicking through the UI and read the
 * resulting GUIDs back off the URL.
 *
 * NOTE: the locators below were written without access to an authenticated
 * session. Run `npm run codegen` once you have a test account to confirm the
 * accessible names, and prefer adding `data-testid` attributes in the app for
 * anything that proves fragile.
 */
export class OpsHomePage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('./');
    await this.page.waitForLoadState('networkidle');
  }

  /** True once we are on the SPA rather than the identity provider. */
  async isAuthenticated(): Promise<boolean> {
    return /\/ops\//.test(this.page.url()) && !(await this.isOnLoginPage());
  }

  async isOnLoginPage(): Promise<boolean> {
    return (await this.page.locator('#username').count()) > 0;
  }

  /** The splash screen the SPA shows while bootstrapping. */
  get splashScreen(): Locator {
    return this.page.locator('#cm-splash-screen');
  }

  /** Wait for the Angular app to finish booting and hide its splash screen. */
  async waitForAppReady(): Promise<void> {
    await expect(this.splashScreen).toBeHidden({ timeout: 60_000 });
  }

  /** Open a plant by its display name, and return the plant GUID from the URL. */
  async openPlantByName(plantName: string): Promise<string> {
    await this.page.getByRole('link', { name: plantName }).first().click();
    await this.page.waitForURL(new RegExp(`/plant/${GUID_PATTERN.source}`, 'i'), {
      timeout: 30_000,
    });
    return this.currentPlantId();
  }

  /** Read the plant GUID out of the current URL. */
  currentPlantId(): string {
    const match = this.page
      .url()
      .match(new RegExp(`/plant/(${GUID_PATTERN.source})`, 'i'));
    if (!match) {
      throw new Error(`No plant GUID found in URL: ${this.page.url()}`);
    }
    return match[1];
  }
}
