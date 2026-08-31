import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });

export const STORAGE_STATE = 'playwright/.auth/user.json';

const baseURL =
  process.env.BASE_URL ?? 'https://feature-us.aquaticinformatics.net/ops/';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'never' }], ['list']],

  // The ops SPA boots slowly and then walks a chain of redirects to restore
  // the user's last context. Firefox in particular needs well over the 30s
  // default to get through a cold load.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      // Signed-out checks. Needs no credentials, so it runs anywhere.
      name: 'public',
      testDir: './tests/public',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Read-only, safe to run against any environment including production.
      name: 'smoke',
      testDir: './tests/smoke',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
    },
    {
      // Everything authenticated, including tests that mutate data.
      // Non-production environments only.
      name: 'full',
      testIgnore: [/\.setup\.ts/, /tests[\\/]public[\\/]/],
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
    },
    {
      name: 'smoke-firefox',
      testDir: './tests/smoke',
      dependencies: ['setup'],
      use: { ...devices['Desktop Firefox'], storageState: STORAGE_STATE },
    },
    {
      name: 'smoke-webkit',
      testDir: './tests/smoke',
      dependencies: ['setup'],
      use: { ...devices['Desktop Safari'], storageState: STORAGE_STATE },
    },
  ],
});
