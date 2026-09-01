import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Matches the GUID segments the ops app uses throughout its routes, e.g.
 * `/ops/plant/<guid>/worksheet/4/view/<guid>`.
 */
export const GUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The authenticated ops application shell: the top toolbar and the left
 * navigation that are present on every plant-scoped page.
 *
 * Route GUIDs are customer- and environment-specific, so nothing here builds a
 * deep link by hand. Tests navigate by clicking and read the resulting GUIDs
 * back off the URL.
 */
export class OpsHomePage {
  readonly toolbar: Locator;

  constructor(private readonly page: Page) {
    this.toolbar = page.locator('mat-toolbar').first();
  }

  async goto(): Promise<void> {
    // Wait only for DOMContentLoaded. The SPA holds long-lived connections
    // open, so the `load` event can stay pending indefinitely — Firefox in
    // particular never fires it. Readiness is asserted explicitly below.
    await this.page.goto('./', { waitUntil: 'domcontentloaded' });
    await this.waitForAppReady();
    await this.waitForContextRestored();
  }

  async isOnLoginPage(): Promise<boolean> {
    return (await this.page.locator('#username').count()) > 0;
  }

  /**
   * Wait for the app to finish restoring the user's last context.
   *
   * On load the app walks a chain of redirects — `/ops/` to the plant, then
   * the section, then the specific record — which completes well after the
   * shell has rendered. Clicking during that window gets silently undone by
   * the pending navigation, so tests must let it finish first.
   */
  async waitForContextRestored(): Promise<void> {
    await this.page.waitForURL(
      new RegExp(`/plant/${GUID_PATTERN.source}/`, 'i'),
      { timeout: 60_000, waitUntil: 'commit' },
    );
    await this.waitForStableUrl();
  }

  /** Wait until the URL stops changing for `quietMs`. */
  async waitForStableUrl(
    { quietMs = 3_000, timeout = 60_000 } = {},
  ): Promise<string> {
    const deadline = Date.now() + timeout;
    let previous = this.page.url();
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      await this.page.waitForTimeout(250);
      const current = this.page.url();

      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince >= quietMs) return current;
    }

    throw new Error(
      `URL did not settle within ${timeout}ms (last seen: ${previous})`,
    );
  }

  /**
   * Wait for the Angular app to finish booting.
   *
   * Note: we deliberately do *not* wait for `#cm-splash-screen` to disappear.
   * The app leaves that element in the DOM and merely fades it out with
   * `opacity: 0; z-index: -10`, which Playwright still considers visible.
   * The toolbar appearing is the reliable signal that the shell has rendered.
   */
  async waitForAppReady(): Promise<void> {
    await expect(this.toolbar).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Wait for the app to restore the user's last plant context.
   *
   * The shell renders before this redirect happens, so reading a plant GUID
   * straight after `waitForAppReady()` is a race.
   */
  async waitForPlantContext(): Promise<string> {
    await this.page.waitForURL(
      new RegExp(`/plant/${GUID_PATTERN.source}`, 'i'),
      { timeout: 60_000, waitUntil: 'commit' },
    );
    return this.currentPlantId();
  }

  /** A left-hand navigation entry, by its visible name. */
  navLink(name: string): Locator {
    return this.page.getByRole('link', { name, exact: true });
  }

  /**
   * Follow a left-hand navigation entry and wait for the route to change.
   * Returns the resulting URL path.
   *
   * Several sections redirect to a deeper default once loaded — Spreadsheets
   * lands on a specific worksheet, Logbook on `/logbook/all`, Dashboard on a
   * dashboard GUID — so the link's href is treated as a prefix rather than an
   * exact destination.
   */
  async openSection(name: string): Promise<string> {
    const link = this.navLink(name);
    const href = await link.getAttribute('href');
    await link.click();

    if (href) {
      await this.page.waitForURL((url) => url.pathname.startsWith(href), {
        timeout: 60_000,
        waitUntil: 'commit',
      });
    }
    await this.waitForAppReady();
    return new URL(this.page.url()).pathname;
  }

  /**
   * Read the plant GUID out of the current URL.
   *
   * On sign-in the app restores the user's last context, so this is available
   * without navigating anywhere first.
   */
  currentPlantId(): string {
    const match = this.page
      .url()
      .match(new RegExp(`/plant/(${GUID_PATTERN.source})`, 'i'));
    if (!match) {
      throw new Error(`No plant GUID found in URL: ${this.page.url()}`);
    }
    return match[1];
  }

  /**
   * Switch the active plant using the toolbar's plant picker.
   *
   * The picker opens a tenant/plant tree that is far too large to browse, so
   * the name is typed into its search box first. Two `Search` boxes exist in
   * the dialog and both filter the same tree; the first is used.
   *
   * Resolves once the URL carries a plant GUID other than the one we started
   * on, which is the app's signal that the new context has loaded.
   */
  async switchToPlant(name: string): Promise<string> {
    const before = this.hasPlantContext() ? this.currentPlantId() : null;

    // The picker is the second toolbar button; it renders as "<tenant> <plant>".
    await this.page.locator('mat-toolbar button').nth(1).click();

    const search = this.page.getByPlaceholder('Search').first();
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill(name);

    const result = this.page.getByText(name, { exact: true }).first();
    await expect(result).toBeVisible({ timeout: 30_000 });
    await result.click();

    await this.page.waitForURL(
      (url) => {
        const match = url.pathname.match(
          new RegExp(`/plant/(${GUID_PATTERN.source})`, 'i'),
        );
        return Boolean(match) && match![1] !== before;
      },
      { timeout: 60_000, waitUntil: 'commit' },
    );

    await this.waitForAppReady();
    await this.waitForStableUrl();
    return this.currentPlantId();
  }

  /** True when the current URL is scoped to a plant. */
  hasPlantContext(): boolean {
    return new RegExp(`/plant/${GUID_PATTERN.source}`, 'i').test(
      this.page.url(),
    );
  }
}
