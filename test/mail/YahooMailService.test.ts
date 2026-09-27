import { describe, expect, it } from 'vitest';
import { YahooMailService, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../src/mail/YahooMailService.js';
import { TransportError, type ImapClient } from '../../src/transport/ImapClient.js';

interface BodyStructureFixture {
  type: string;
  part?: string;
  encoding?: string;
  childNodes?: BodyStructureFixture[];
}

interface FakeMessage {
  uid: number;
  envelope: {
    from?: { name?: string; address?: string }[];
    subject?: string;
    date?: Date;
  };
  flags: Set<string>;
  bodyStructure?: BodyStructureFixture;
  internalDate: Date;
  /** Single-part body text, used when `bodyByPart` doesn't have an entry for the requested part. */
  bodyText?: string;
  /** Per-part-id body text, for fixtures with more than one leaf part. */
  bodyByPart?: Record<string, string>;
}

class FakeImap {
  mailbox: { exists: number };
  readonly fetchCalls: Array<{ range: string; query: unknown }> = [];
  readonly fetchOneCalls: Array<{ uid: number; query: unknown; options: unknown }> = [];

  constructor(private readonly messages: FakeMessage[]) {
    this.mailbox = { exists: messages.length };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *fetch(range: string, query: unknown) {
    this.fetchCalls.push({ range, query });
    for (const m of this.messages) {
      yield {
        uid: m.uid,
        envelope: m.envelope,
        flags: m.flags,
        bodyStructure: m.bodyStructure,
        internalDate: m.internalDate,
      };
    }
  }

  async fetchOne(uid: number, query: { bodyParts: string[] }, options: { uid: boolean }) {
    this.fetchOneCalls.push({ uid, query, options });
    const message = this.messages.find((m) => m.uid === uid);
    if (!message) {
      return false;
    }
    const partId = query.bodyParts[0]!;
    const text = message.bodyByPart?.[partId] ?? message.bodyText;
    if (text === undefined) {
      return false;
    }
    const bodyParts = new Map<string, Buffer>();
    bodyParts.set(partId, Buffer.from(text, 'utf8'));
    return { uid, bodyParts };
  }
}

function makeMessages(count: number): FakeMessage[] {
  const messages: FakeMessage[] = [];
  for (let uid = 1; uid <= count; uid++) {
    messages.push({
      uid,
      envelope: {
        from: [{ name: `Sender ${uid}`, address: `sender${uid}@example.com` }],
        subject: `Subject ${uid}`,
        date: new Date(Date.UTC(2026, 0, 1, 0, 0, uid)),
      },
      flags: new Set(uid % 2 === 0 ? ['\\Seen'] : []),
      bodyStructure: { type: 'text/plain', part: '1', encoding: '7bit' },
      internalDate: new Date(Date.UTC(2026, 0, 1, 0, 0, uid)),
      bodyText: `Body of message ${uid}`,
    });
  }
  return messages;
}

/** Wraps a FakeImap in something structurally compatible enough with ImapClient for tests. */
function setup(messages: FakeMessage[]): { service: YahooMailService; fakeImap: FakeImap } {
  const fakeImap = new FakeImap(messages);
  const fakeClient = {
    useInbox: async (op: (imap: unknown) => Promise<unknown>) => op(fakeImap),
  } as unknown as ImapClient;
  return { service: new YahooMailService(fakeClient), fakeImap };
}

function serviceFor(messages: FakeMessage[]): YahooMailService {
  return setup(messages).service;
}

function serviceThatFails(err: unknown): YahooMailService {
  const fakeClient = {
    useInbox: async () => {
      throw err;
    },
  } as unknown as ImapClient;
  return new YahooMailService(fakeClient);
}

describe('YahooMailService.listInbox -- cap and default', () => {
  it('defaults to 20 results, newest first, when no limit is given', async () => {
    const service = serviceFor(makeMessages(120));
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(DEFAULT_LIST_LIMIT);
    expect(result.data[0]!.id).toBe('120');
    expect(result.data[19]!.id).toBe('101');
  });

  it('caps a limit above 100 at exactly 100 results', async () => {
    const service = serviceFor(makeMessages(120));
    const result = await service.listInbox(150);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(MAX_LIST_LIMIT);
    expect(result.data[0]!.id).toBe('120');
    expect(result.data[99]!.id).toBe('21');
  });

  it('honors a limit below the default', async () => {
    const service = serviceFor(makeMessages(120));
    const result = await service.listInbox(5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((m) => m.id)).toEqual(['120', '119', '118', '117', '116']);
  });

  it('returns fewer than the limit when the inbox has fewer messages', async () => {
    const service = serviceFor(makeMessages(3));
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
  });

  it('returns an empty list for an empty inbox', async () => {
    const service = serviceFor([]);
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it('treats a non-positive or invalid limit as the default', async () => {
    const service = serviceFor(makeMessages(30));
    const result = await service.listInbox(-5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(DEFAULT_LIST_LIMIT);
  });

  it('treats a non-integer limit between 0 and 1 as the default (not 0)', async () => {
    const service = serviceFor(makeMessages(30));
    const result = await service.listInbox(0.5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(DEFAULT_LIST_LIMIT);
  });

  it('computes the sequence range from exists and limit and passes it to fetch', async () => {
    const { service, fakeImap } = setup(makeMessages(30));
    await service.listInbox(5);

    expect(fakeImap.fetchCalls).toHaveLength(1);
    expect(fakeImap.fetchCalls[0]!.range).toBe('26:*');
  });
});

describe('YahooMailService.listInbox -- MessageSummary shape', () => {
  it('produces the { id, from, subject, date, unread, snippet } shape', async () => {
    const service = serviceFor(makeMessages(1));
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    const summary = result.data[0]!;
    expect(summary).toEqual({
      id: '1',
      from: 'Sender 1 <sender1@example.com>',
      subject: 'Subject 1',
      date: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString(),
      unread: true,
      snippet: 'Body of message 1',
    });
  });

  it('marks a message with the \\Seen flag as read (unread: false)', async () => {
    const service = serviceFor(makeMessages(2)); // uid 2 is seen (even)
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seen = result.data.find((m) => m.id === '2');
    expect(seen?.unread).toBe(false);
  });

  it('fetches the snippet body part in UID-addressing mode (not by sequence number)', async () => {
    const { service, fakeImap } = setup(makeMessages(1));
    await service.listInbox();

    expect(fakeImap.fetchOneCalls).toHaveLength(1);
    expect(fakeImap.fetchOneCalls[0]!.options).toEqual({ uid: true });
  });

  it('decodes a quoted-printable snippet and truncates it to ~200 characters', async () => {
    const longText = 'A'.repeat(300);
    const messages: FakeMessage[] = [
      {
        uid: 1,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'QP', date: new Date() },
        flags: new Set(),
        bodyStructure: { type: 'text/plain', part: '1', encoding: 'quoted-printable' },
        internalDate: new Date(),
        bodyText: longText.replace(/(.{50})/g, '$1=\r\n'),
      },
    ];
    const service = serviceFor(messages);
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.snippet).toBe('A'.repeat(200));
  });

  it('decodes a base64 snippet', async () => {
    const original = 'Hello from base64 land';
    const messages: FakeMessage[] = [
      {
        uid: 1,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'B64', date: new Date() },
        flags: new Set(),
        bodyStructure: { type: 'text/plain', part: '1', encoding: 'base64' },
        internalDate: new Date(),
        bodyText: Buffer.from(original, 'utf8').toString('base64'),
      },
    ];
    const service = serviceFor(messages);
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.snippet).toBe(original);
  });

  it('strips HTML tags when no text/plain part is available', async () => {
    const messages: FakeMessage[] = [
      {
        uid: 1,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'HTML', date: new Date() },
        flags: new Set(),
        bodyStructure: { type: 'text/html', part: '1', encoding: '7bit' },
        internalDate: new Date(),
        bodyText: '<p>Hello <b>world</b>&nbsp;&amp; friends</p>',
      },
    ];
    const service = serviceFor(messages);
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.snippet).toBe('Hello world & friends');
  });

  it('falls back to an empty snippet when there is no readable text part', async () => {
    const messages: FakeMessage[] = [
      {
        uid: 1,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'No body', date: new Date() },
        flags: new Set(),
        bodyStructure: undefined,
        internalDate: new Date(),
      },
    ];
    const service = serviceFor(messages);
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.snippet).toBe('');
  });

  it('picks the first text/plain leaf in document order when there are two', async () => {
    const messages: FakeMessage[] = [
      {
        uid: 1,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Two plains', date: new Date() },
        flags: new Set(),
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            { type: 'text/plain', part: '1', encoding: '7bit' },
            { type: 'text/plain', part: '2', encoding: '7bit' },
          ],
        },
        internalDate: new Date(),
        bodyByPart: { '1': 'first part wins', '2': 'second part loses' },
      },
    ];
    const service = serviceFor(messages);
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.snippet).toBe('first part wins');
  });

  it('prefers a text/plain child over an earlier text/html sibling', async () => {
    const messages: FakeMessage[] = [
      {
        uid: 1,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Alternative', date: new Date() },
        flags: new Set(),
        bodyStructure: {
          type: 'multipart/alternative',
          childNodes: [
            { type: 'text/html', part: '1', encoding: '7bit' },
            { type: 'text/plain', part: '2', encoding: '7bit' },
          ],
        },
        internalDate: new Date(),
        bodyByPart: { '1': '<p>html version</p>', '2': 'plain version wins' },
      },
    ];
    const service = serviceFor(messages);
    const result = await service.listInbox();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.snippet).toBe('plain version wins');
  });
});

describe('YahooMailService.listInbox -- transport failure mapping', () => {
  it('maps a TransportError to a { ok: false, error } result instead of throwing', async () => {
    const service = serviceThatFails(new TransportError('auth', 'invalid credentials -- check the App Password and account address'));
    const result = await service.listInbox();

    expect(result).toEqual({
      ok: false,
      error: { kind: 'auth', message: 'invalid credentials -- check the App Password and account address' },
    });
  });

  it('maps a connection_limit TransportError through unchanged', async () => {
    const message = 'too many connections to this Yahoo account -- close other mail clients and try again';
    const service = serviceThatFails(new TransportError('connection_limit', message));
    const result = await service.listInbox();

    expect(result).toEqual({ ok: false, error: { kind: 'connection_limit', message } });
  });

  it('rethrows a non-TransportError as a programmer error', async () => {
    const service = serviceThatFails(new Error('boom'));
    await expect(service.listInbox()).rejects.toThrow('boom');
  });
});
