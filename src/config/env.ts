/**
 * Centralised, validated access to environment configuration.
 *
 * Values come from `.env` locally (gitignored) or from CI secrets.
 * Nothing else in this repo should read `process.env` directly.
 */

export const STORAGE_STATE = 'playwright/.auth/user.json';

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

  /**
   * Sample Manager fixture, used by the AQI-11578 custom-observation tests.
   *
   * Unlike the rest of the suite these cannot navigate purely by name: the
   * behaviour under test only exists when an analyte is linked to a Rio
   * parameter that defines custom observations, which is a specific piece of
   * per-operation configuration rather than something any plant has.
   *
   * These tests write real data and unsubmit a real sample (see
   * `tests/full/sample-manager-custom-observation.spec.ts`), so there is
   * deliberately no hard-coded default here: point every one of these at a
   * dedicated, disposable operation/sample you are comfortable with the
   * suite mutating, never at shared or production configuration. See
   * `.env.example` and the README for how to set one up.
   */
  sampleManager: {
    /** Operation GUID whose Sample Manager has a text analyte configured. */
    get plantId(): string {
      return required('SAMPLE_MANAGER_PLANT_ID');
    },
    /** A text analyte linked to a custom-observation parameter. */
    get textAnalyte(): string {
      return required('SAMPLE_MANAGER_TEXT_ANALYTE');
    },
    /** A sample on the current week carrying that analyte. */
    get sampleName(): string {
      return required('SAMPLE_MANAGER_SAMPLE_NAME');
    },
    /** One of the custom observations configured on that analyte. */
    get customObservation(): string {
      return required('SAMPLE_MANAGER_CUSTOM_OBSERVATION');
    },
  },
};
