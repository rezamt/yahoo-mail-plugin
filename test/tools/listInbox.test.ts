import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { TOOL_NAME, listInboxInputShape, registerListInboxTool } from '../../src/tools/listInbox.js';
import type { YahooMailService } from '../../src/mail/YahooMailService.js';

const limitSchema = z.object(listInboxInputShape);

describe('yahoo_list_inbox input schema', () => {
  it('accepts a missing limit', () => {
    expect(limitSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a positive integer limit, including one above the cap', () => {
    expect(limitSchema.safeParse({ limit: 20 }).success).toBe(true);
    expect(limitSchema.safeParse({ limit: 150 }).success).toBe(true);
  });

  it('rejects a zero, negative, or non-integer limit', () => {
    expect(limitSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(limitSchema.safeParse({ limit: -5 }).success).toBe(false);
    expect(limitSchema.safeParse({ limit: 3.5 }).success).toBe(false);
  });

  it('rejects a non-numeric limit', () => {
    expect(limitSchema.safeParse({ limit: 'twenty' }).success).toBe(false);
  });
});

function fakeMailService(listInbox: YahooMailService['listInbox']): YahooMailService {
  return { listInbox } as unknown as YahooMailService;
}

async function connectedClient(mail: YahooMailService) {
  const server = new McpServer({ name: 'yahoo-mail-plugin-test', version: '0.0.0' });
  registerListInboxTool(server, mail);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('yahoo_list_inbox tool handler (via a real MCP round trip)', () => {
  it('registers and exposes yahoo_list_inbox', async () => {
    const { client } = await connectedClient(fakeMailService(async () => ({ ok: true, data: [] })));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain(TOOL_NAME);
  });

  it('calls mail/listInbox and returns its data as a JSON content block', async () => {
    const summary = {
      id: '482',
      from: 'someone@example.com',
      subject: 'Hello',
      date: '2026-01-01T00:00:00.000Z',
      unread: true,
      snippet: 'Hi there',
    };
    let receivedLimit: number | undefined;
    const { client } = await connectedClient(
      fakeMailService(async (limit) => {
        receivedLimit = limit;
        return { ok: true, data: [summary] };
      })
    );

    const result = await client.callTool({ name: TOOL_NAME, arguments: { limit: 5 } });

    expect(result.isError).toBeFalsy();
    expect(receivedLimit).toBe(5);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ ok: true, data: [summary] });
  });

  it('marks the MCP result as an error when mail/ reports a transport failure', async () => {
    const { client } = await connectedClient(
      fakeMailService(async () => ({
        ok: false,
        error: { kind: 'auth', message: 'invalid credentials -- check the App Password and account address' },
      }))
    );

    const result = await client.callTool({ name: TOOL_NAME, arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { kind: 'auth', message: 'invalid credentials -- check the App Password and account address' },
    });
  });

  it('rejects an invalid limit before the handler ever runs', async () => {
    let called = false;
    const { client } = await connectedClient(
      fakeMailService(async () => {
        called = true;
        return { ok: true, data: [] };
      })
    );

    const result = await client.callTool({ name: TOOL_NAME, arguments: { limit: -5 } });

    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });
});
