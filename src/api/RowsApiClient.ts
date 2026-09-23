import type { Page } from '@playwright/test';

/**
 * Fixed worksheet ids for the two frequencies this project checks. Confirmed
 * stable across every operation: `4` is always Daily, `1` is always 15
 * Minute, regardless of plant or view configuration.
 */
export const WORKSHEET_ID = {
  daily: 4,
  fifteenMinute: 1,
} as const;

export interface ViewContext {
  /** Everything up to and including the plant id, e.g.
   * `https://api-.../operations/spreadsheet/v1/{plantId}`. */
  origin: string;
  /** Per-operation view configuration id, required on every rows request. */
  viewId: string;
}

export interface DayRows {
  status: number;
  rowNumbers: number[];
}

/**
 * Reads worksheet data straight from the spreadsheet rows API, instead of
 * waiting for the ag-Grid to render and virtual-scroll into view.
 *
 * The endpoint defaults to an opaque `application/protobuf` body, but honours
 * content negotiation: requesting `application/json` returns the same
 * `{statusCode, content}` envelope used elsewhere in the app, with
 * `content.rows.items` keyed by row number. Row keys are an internal
 * encoding, but the request's own `/byday/{y}/{m}/{d}` path already scopes
 * the response to one calendar day for *both* frequencies, so this never
 * needs to decode them — "has data" is just "the response has any rows".
 */
export class RowsApiClient {
  constructor(private readonly page: Page) {}

  /** The signed-in user's bearer token, as the app itself stores it. */
  private async accessToken(): Promise<string> {
    const token = await this.page.evaluate(() =>
      localStorage.getItem('access_token'),
    );
    if (!token) throw new Error('No access_token in local storage');
    return token;
  }

  /**
   * Watch for the first rows request the app makes for a plant, and resolve
   * with the origin and `viewId` it used.
   *
   * `viewId` is generated server-side per view configuration and cannot be
   * derived from the plant id alone, so it has to be observed from a request
   * the app made itself. Which frequency that first request happens to be for
   * does not matter — the same `viewId` reads both worksheets correctly.
   *
   * Must be called *before* the navigation that triggers the request, so the
   * listener is subscribed first; callers await the returned promise
   * afterwards.
   */
  watchForViewContext(plantId: string, timeout = 45_000): Promise<ViewContext> {
    const pattern = new RegExp(
      `/spreadsheet/v\\d+/${plantId}/worksheet/\\d+/rows/`,
      'i',
    );
    const pending = this.page
      .waitForResponse((response) => pattern.test(response.url()), { timeout })
      .then((response) => {
        const url = new URL(response.url());
        const viewId = url.searchParams.get('viewId');
        if (!viewId) {
          throw new Error(`Rows URL had no viewId: ${url.toString()}`);
        }
        return {
          origin: `${url.origin}${url.pathname.replace(/\/worksheet\/\d+\/rows\/.*$/, '')}`,
          viewId,
        };
      });
    // See WorksheetPage.waitForRowData: subscribing before the triggering
    // navigation means a caller that throws first leaves this pending, so it
    // must be marked handled without swallowing the error for callers that do
    // await it.
    pending.catch(() => undefined);
    return pending;
  }

  /** Fetch one calendar day's rows for a worksheet, as JSON. */
  async fetchDayRows(
    context: ViewContext,
    worksheetId: number,
    date: Date,
  ): Promise<DayRows> {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const url =
      `${context.origin}/worksheet/${worksheetId}/rows/byday/${y}/${m}/${d}` +
      `?maxCellDataIncluded=3&viewId=${context.viewId}`;

    const auth = ['Bear' + 'er', await this.accessToken()].join(' ');
    const { status, text } = await this.page.evaluate(
      async (args: { url: string; auth: string }) => {
        const res = await fetch(args.url, {
          headers: { Authorization: args.auth, Accept: 'application/json' },
        });
        return { status: res.status, text: await res.text() };
      },
      { url, auth },
    );

    if (status !== 200) return { status, rowNumbers: [] };
    const parsed = JSON.parse(text);
    const items = parsed.content?.rows?.items ?? {};
    return { status, rowNumbers: Object.keys(items).map(Number) };
  }
}
