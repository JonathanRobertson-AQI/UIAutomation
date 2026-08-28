/**
 * Centralised, validated access to environment configuration.
 *
 * Values come from `.env` locally (gitignored) or from CI secrets.
 * Nothing else in this repo should read `process.env` directly.
 */

export const STORAGE_STATE = 'playwright/.auth/user.json';
export const SESSION_STORAGE_STATE = 'playwright/.auth/session-storage.json';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in (see README.md).`,
    );
  }
  return value;
}

export const env = {
  get baseURL(): string {
    return (
      process.env.BASE_URL ?? 'https://feature-us.aquaticinformatics.net/ops/'
    );
  },
  get username(): string {
    return required('TEST_USER');
  },
  get password(): string {
    return required('TEST_PASSWORD');
  },
  /** Name of a plant the test account can read. Optional. */
  get plantName(): string | undefined {
    return process.env.TEST_PLANT_NAME || undefined;
  },
  /** Name of a worksheet within the above plant. Optional. */
  get worksheetName(): string | undefined {
    return process.env.TEST_WORKSHEET_NAME || undefined;
  },
};
