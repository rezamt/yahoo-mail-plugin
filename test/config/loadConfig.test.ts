import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loadConfig.js';

describe('loadConfig', () => {
  it('returns the account email and app password when both are set', () => {
    const config = loadConfig({
      YAHOO_ACCOUNT_EMAIL: 'someone@yahoo.com',
      YAHOO_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
    });

    expect(config).toEqual({
      accountEmail: 'someone@yahoo.com',
      appPassword: 'abcd-efgh-ijkl-mnop',
    });
  });

  it('throws at load time when YAHOO_ACCOUNT_EMAIL is missing', () => {
    expect(() => loadConfig({ YAHOO_APP_PASSWORD: 'secret' })).toThrow(/YAHOO_ACCOUNT_EMAIL/);
  });

  it('throws at load time when YAHOO_APP_PASSWORD is missing', () => {
    expect(() => loadConfig({ YAHOO_ACCOUNT_EMAIL: 'someone@yahoo.com' })).toThrow(
      /YAHOO_APP_PASSWORD/
    );
  });

  it('throws when both are missing, naming both variables', () => {
    expect(() => loadConfig({})).toThrow(/YAHOO_ACCOUNT_EMAIL.*YAHOO_APP_PASSWORD/s);
  });

  it('treats a blank value the same as a missing one', () => {
    expect(() =>
      loadConfig({ YAHOO_ACCOUNT_EMAIL: '   ', YAHOO_APP_PASSWORD: 'secret' })
    ).toThrow(/YAHOO_ACCOUNT_EMAIL/);
  });

  it('never includes the credential value in its error message', () => {
    const secret = 'super-secret-app-password';
    try {
      loadConfig({ YAHOO_ACCOUNT_EMAIL: 'someone@yahoo.com', YAHOO_APP_PASSWORD: '' });
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
      return;
    }
    throw new Error('expected loadConfig to throw');
  });
});
