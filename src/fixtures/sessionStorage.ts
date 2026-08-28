import fs from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { SESSION_STORAGE_STATE } from '../config/env';

/**
 * Playwright's `storageState` persists cookies and localStorage, but *not*
 * sessionStorage. The ops app authenticates with OIDC implicit flow, and
 * such apps commonly keep their tokens in sessionStorage, so we capture and
 * restore it separately to make authentication reuse reliable either way.
 */

type SessionStorageDump = Record<string, string>;

export async function saveSessionStorage(page: Page): Promise<void> {
  const dump: SessionStorageDump = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(window.sessionStorage).map((key) => [
        key,
        window.sessionStorage.getItem(key) ?? '',
      ]),
    ),
  );

  fs.mkdirSync('playwright/.auth', { recursive: true });
  fs.writeFileSync(SESSION_STORAGE_STATE, JSON.stringify(dump, null, 2));
}

/**
 * Replay the captured sessionStorage into every page of a context before any
 * application script runs. A no-op when nothing was captured.
 */
export async function restoreSessionStorage(
  context: BrowserContext,
): Promise<void> {
  if (!fs.existsSync(SESSION_STORAGE_STATE)) return;

  const dump = JSON.parse(
    fs.readFileSync(SESSION_STORAGE_STATE, 'utf-8'),
  ) as SessionStorageDump;

  if (Object.keys(dump).length === 0) return;

  await context.addInitScript((entries: SessionStorageDump) => {
    for (const [key, value] of Object.entries(entries)) {
      window.sessionStorage.setItem(key, value);
    }
  }, dump);
}
