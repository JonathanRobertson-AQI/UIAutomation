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
   * Open the toolbar's operation picker and return the dialog.
   *
   * The picker is the second toolbar button; it renders as "<tenant> <plant>".
   */
  async openOperationPicker(): Promise<Locator> {
    await this.page.locator('mat-toolbar button').nth(1).click();

    const dialog = this.page
      .locator('.cdk-overlay-container, [role="dialog"]')
      .filter({ hasText: 'Select operation' })
      .last();
    await expect(dialog.getByPlaceholder('Search').first()).toBeVisible({
      timeout: 30_000,
    });
    return dialog;
  }

  /**
   * Narrow the picker to operations matching `name` and return a locator over
   * every match.
   *
   * Searching filters the tree down to matching branches but leaves those
   * branches *collapsed*, so the matching leaves are not in the DOM until the
   * tree is expanded. Both steps are required to find anything.
   *
   * The same operation name can exist under many tenants, so this deliberately
   * returns all matches rather than assuming there is one.
   */
  async findOperations(name: string): Promise<Locator> {
    const dialog = await this.openOperationPicker();

    const search = dialog.getByPlaceholder('Search').first();
    await search.fill(name);
    await search.press('Enter');

    const expandAll = dialog.getByText('Expand all', { exact: true });
    if (await expandAll.count()) {
      await expandAll.click();
    }

    const matches = dialog.getByText(name, { exact: true });
    await expect(matches.first()).toBeVisible({ timeout: 30_000 });
    return matches;
  }

  /**
   * Switch the active operation (plant) by name.
   *
   * The same operation name can exist under many tenants. `pick` chooses among
   * the matches given how many were found, defaulting to the first. Selection
   * happens in a single pass because the picker's overlay blocks clicks on the
   * toolbar, so the dialog cannot be reopened to count matches separately.
   *
   * Resolves once the URL carries a plant GUID other than the one we started
   * on, which is the app's signal that the new context has loaded.
   */
  async switchToOperation(
    name: string,
    pick: (instanceCount: number) => number = () => 0,
  ): Promise<{ plantId: string; index: number; instanceCount: number }> {
    const before = this.hasPlantContext() ? this.currentPlantId() : null;

    const matches = await this.findOperations(name);
    const instanceCount = await matches.count();
    const index = pick(instanceCount);

    await matches.nth(index).click();

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
    return { plantId: this.currentPlantId(), index, instanceCount };
  }

  /** Switch to a named operation, taking the first match. */
  async switchToPlant(name: string, index = 0): Promise<string> {
    const { plantId } = await this.switchToOperation(name, () => index);
    return plantId;
  }

  /**
   * Open an operation's worksheet directly, by the GUID the app uses in its
   * routes, without going through the picker.
   *
   * The trailing worksheet number must be omitted. `/plant/<id>/worksheet/4`
   * is *silently redirected back to the operation the user was last on* —
   * the page still renders a perfectly healthy worksheet, just for the wrong
   * plant — whereas `/plant/<id>/worksheet` is honoured and lands on that
   * operation's own default view. The check below turns any such bounce into a
   * failure rather than letting it be read as the target's data.
   */
  async gotoOperationWorksheet(operationId: string): Promise<string> {
    await this.page.goto(`./plant/${operationId}/worksheet`, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForAppReady();
    // Generous: every navigation re-boots the SPA, which refetches the whole
    // multi-megabyte operation hierarchy. Under concurrency that comfortably
    // outruns the default navigation timeout.
    await this.page.waitForURL(
      new RegExp(`/plant/${operationId}/worksheet/`, 'i'),
      { timeout: 120_000, waitUntil: 'commit' },
    );
    // The app keeps redirecting to the default view after the worksheet route
    // matches. Reading the grid before that settles races the navigation and
    // tears down the execution context mid-evaluate.
    await this.waitForStableUrl();

    const landed = this.currentPlantId();
    if (landed.toLowerCase() !== operationId.toLowerCase()) {
      throw new Error(
        `Navigating to operation ${operationId} landed on ${landed} instead. ` +
          `The app redirects unresolvable deep links to the last-used ` +
          `operation, so this reading would belong to the wrong plant.`,
      );
    }
    return landed;
  }

  /** True when the current URL is scoped to a plant. */
  hasPlantContext(): boolean {
    return new RegExp(`/plant/${GUID_PATTERN.source}`, 'i').test(
      this.page.url(),
    );
  }
}
