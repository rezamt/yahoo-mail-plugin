import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { buildServer } from '../../src/server.js';
import { YahooMailService } from '../../src/mail/YahooMailService.js';
import { TOOL_NAME } from '../../src/tools/listInbox.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.YAHOO_ACCOUNT_EMAIL = 'someone@yahoo.com';
  process.env.YAHOO_APP_PASSWORD = 'a-yahoo-app-password';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('buildServer', () => {
  it('wires config -> ImapClient -> YahooMailService -> yahoo_list_inbox registration', async () => {
    // Stubs the business-logic layer so this test never opens a real IMAP connection; it only
    // asserts that buildServer()'s wiring reaches a genuine YahooMailService instance.
    const listInboxSpy = vi
      .spyOn(YahooMailService.prototype, 'listInbox')
      .mockResolvedValue({ ok: true, data: [] });

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain(TOOL_NAME);

    const result = await client.callTool({ name: TOOL_NAME, arguments: { limit: 7 } });

    expect(listInboxSpy).toHaveBeenCalledTimes(1);
    expect(listInboxSpy).toHaveBeenCalledWith(7);
    expect(result.isError).toBeFalsy();
  });
});
