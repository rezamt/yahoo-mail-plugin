/**
 * Reads the Yahoo Mail credentials from the process environment exactly once, at startup.
 *
 * This is the sole entry point through which the App Password and account address enter the
 * process. Nothing here ever logs, echoes, or interpolates a credential value into any output,
 * including its own error messages -- a missing variable is reported by name only.
 */

export interface AppConfig {
  /** The Yahoo account address (e.g. "someone@yahoo.com"). */
  readonly accountEmail: string;
  /** The Yahoo App Password (2FA-based), never the account's regular password. */
  readonly appPassword: string;
}

const ACCOUNT_EMAIL_VAR = 'YAHOO_ACCOUNT_EMAIL';
const APP_PASSWORD_VAR = 'YAHOO_APP_PASSWORD';

/**
 * Loads and validates the required environment variables.
 *
 * @param env The environment to read from. Defaults to `process.env`; tests may pass a fake.
 * @throws {Error} if either required variable is missing or blank. The message names only the
 *   missing variable(s), never any credential value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const accountEmail = env[ACCOUNT_EMAIL_VAR]?.trim();
  const appPassword = env[APP_PASSWORD_VAR]?.trim();

  const missing: string[] = [];
  if (!accountEmail) {
    missing.push(ACCOUNT_EMAIL_VAR);
  }
  if (!appPassword) {
    missing.push(APP_PASSWORD_VAR);
  }

  if (missing.length > 0) {
    throw new Error(
      `yahoo-mail-plugin: missing required environment variable(s): ${missing.join(', ')}`
    );
  }

  return { accountEmail: accountEmail as string, appPassword: appPassword as string };
}
