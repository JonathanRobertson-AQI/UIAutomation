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
   * per-operation configuration rather than something any plant has. The
   * defaults point at the operation set up for this epic on feature-us.
   */
  sampleManager: {
    /** Operation GUID whose Sample Manager has a text analyte configured. */
    get plantId(): string {
      return (
        process.env.SAMPLE_MANAGER_PLANT_ID ??
        '5e1f8cef-ec33-47a4-b924-e825bcfe6e79'
      );
    },
    /** A text analyte linked to a custom-observation parameter. */
    get textAnalyte(): string {
      return process.env.SAMPLE_MANAGER_TEXT_ANALYTE ?? "Just Kidding It's Text";
    },
    /** A sample on the current week carrying that analyte. */
    get sampleName(): string {
      return process.env.SAMPLE_MANAGER_SAMPLE_NAME ?? 'Ad hoc Test again';
    },
    /** One of the custom observations configured on that analyte. */
    get customObservation(): string {
      return process.env.SAMPLE_MANAGER_CUSTOM_OBSERVATION ?? 'Please';
    },
  },
};
