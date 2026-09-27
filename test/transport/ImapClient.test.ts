import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A scripted stand-in for `imapflow`'s `ImapFlow` class. Each test pushes a queue of `connect()`
 * behaviors (success or a specific thrown error shape) and reads back `instances`/`connectCallCount`
 * to assert exactly how many connection attempts were made.
 */
class FakeImapFlow {
  static script: Array<() => void> = [];
  static instances: FakeImapFlow[] = [];
  static connectCallCount = 0;

  usable = true;
  mailbox: { uidValidity: bigint; exists: number } | undefined;
  readonly options: unknown;

  constructor(options: unknown) {
    this.options = options;
    FakeImapFlow.instances.push(this);
  }

  async connect(): Promise<void> {
    FakeImapFlow.connectCallCount++;
    const behavior = FakeImapFlow.script.shift();
    if (!behavior) {
      throw new Error('test setup error: no scripted connect() behavior left');
    }
    behavior();
  }

  async mailboxOpen(_path: string) {
    this.mailbox = { uidValidity: 42n, exists: 3 };
    return this.mailbox;
  }
}

vi.mock('imapflow', () => ({ ImapFlow: FakeImapFlow }));

// Imported after the mock so ImapClient picks up FakeImapFlow.
const { ImapClient, TransportError } = await import('../../src/transport/ImapClient.js');

function ok(): () => void {
  return () => {
    /* connect() resolves */
  };
}

function fail(err: Record<string, unknown>): () => void {
  return () => {
    throw err;
  };
}

beforeEach(() => {
  FakeImapFlow.script = [];
  FakeImapFlow.instances = [];
  FakeImapFlow.connectCallCount = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ImapClient error classification', () => {
  it('classifies a TCP/TLS connect failure as network_timeout, single attempt', async () => {
    FakeImapFlow.script = [fail({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret-app-password' });

    await expect(client.useInbox(async () => 'never')).rejects.toMatchObject({
      kind: 'network_timeout',
    });
    expect(FakeImapFlow.connectCallCount).toBe(1);
  });

  it('classifies a bad-credentials login rejection as auth', async () => {
    FakeImapFlow.script = [
      fail({
        authenticationFailed: true,
        serverResponseCode: 'AUTHENTICATIONFAILED',
        responseText: 'AUTHENTICATIONFAILED invalid credentials for super-secret-app-password',
      }),
    ];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'super-secret-app-password' });

    const error = await client.useInbox(async () => 'never').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as InstanceType<typeof TransportError>).kind).toBe('auth');
    expect((error as Error).message).not.toContain('super-secret-app-password');
    expect(FakeImapFlow.connectCallCount).toBe(1);
  });

  it('falls back to a generic auth message for an unclassifiable login refusal', async () => {
    FakeImapFlow.script = [
      fail({ authenticationFailed: true, responseText: 'NO command rejected for policy reasons' }),
    ];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    const error = await client.useInbox(async () => 'never').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as InstanceType<typeof TransportError>).kind).toBe('auth');
    expect((error as Error).message).toBe('server refused the connection');
  });

  it('never lets the raw exception, message, or stack escape as the reported message', async () => {
    const rawMessage = 'RAW-IMAP-INTERNALS-should-never-leak';
    const err = new Error(rawMessage) as Error & Record<string, unknown>;
    err.code = 'ETIMEDOUT';
    FakeImapFlow.script = [
      () => {
        throw err;
      },
    ];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    const error = await client.useInbox(async () => 'never').catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(rawMessage);
    expect((error as Error).stack ?? '').not.toContain(rawMessage);
  });
});

describe('ImapClient connection_limit retry', () => {
  it('waits the deliberate delay, retries exactly once, and succeeds if the retry succeeds', async () => {
    vi.useFakeTimers();
    FakeImapFlow.script = [
      fail({ authenticationFailed: true, responseText: 'Too many simultaneous connections' }),
      ok(),
    ];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    let settled = false;
    const resultPromise = client.useInbox(async () => 'done').then(
      (v) => {
        settled = true;
        return v;
      },
      (e) => {
        settled = true;
        throw e;
      }
    );

    // Let the first (failing) connect attempt run.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // Not yet at the 5s mark: still waiting.
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);

    // Crossing the 5s mark triggers the retry, which succeeds.
    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toBe('done');
    expect(FakeImapFlow.connectCallCount).toBe(2);
  });

  it('reports connection_limit if the retry also fails', async () => {
    vi.useFakeTimers();
    FakeImapFlow.script = [
      fail({ authenticationFailed: true, responseText: 'too many connections right now' }),
      fail({ authenticationFailed: true, responseText: 'still too many connections' }),
    ];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    const resultPromise = client.useInbox(async () => 'never').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await resultPromise;

    expect(error).toBeInstanceOf(TransportError);
    expect((error as InstanceType<typeof TransportError>).kind).toBe('connection_limit');
    expect((error as Error).message).toBe(
      'too many connections to this Yahoo account -- close other mail clients and try again'
    );
    expect(FakeImapFlow.connectCallCount).toBe(2);
  });

  it('does not retry auth or network_timeout failures', async () => {
    FakeImapFlow.script = [fail({ code: 'ENOTFOUND' })];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    await expect(client.useInbox(async () => 'never')).rejects.toMatchObject({
      kind: 'network_timeout',
    });
    expect(FakeImapFlow.connectCallCount).toBe(1);
  });
});

describe('ImapClient connection handling', () => {
  it('re-SELECTs INBOX before every operation', async () => {
    FakeImapFlow.script = [ok()];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    const mailboxOpenSpy = vi.spyOn(FakeImapFlow.prototype, 'mailboxOpen');

    await client.useInbox(async () => 'first');
    await client.useInbox(async () => 'second');

    expect(mailboxOpenSpy).toHaveBeenCalledTimes(2);
    expect(mailboxOpenSpy).toHaveBeenCalledWith('INBOX');
  });

  it('reconnects immediately (no artificial delay) when the connection has dropped', async () => {
    FakeImapFlow.script = [ok(), ok()];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    await client.useInbox(async () => 'first');
    expect(FakeImapFlow.connectCallCount).toBe(1);

    // Simulate the connection dropping.
    FakeImapFlow.instances[0]!.usable = false;

    await client.useInbox(async () => 'second');
    expect(FakeImapFlow.connectCallCount).toBe(2);
  });

  it('reuses the existing connection while it stays usable', async () => {
    FakeImapFlow.script = [ok()];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    await client.useInbox(async () => 'first');
    await client.useInbox(async () => 'second');

    expect(FakeImapFlow.connectCallCount).toBe(1);
  });

  it('records UIDVALIDITY on the first successful SELECT INBOX', async () => {
    FakeImapFlow.script = [ok()];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    expect(client.uidValidity).toBeUndefined();
    await client.useInbox(async () => 'first');
    expect(client.uidValidity).toBe(42n);
  });

  it('classifies an operation-stage failure and forces a fresh reconnect next time', async () => {
    FakeImapFlow.script = [ok(), ok()];
    const client = new ImapClient({ user: 'someone@yahoo.com', pass: 'secret' });

    const error = await client
      .useInbox(async () => {
        throw new Error('socket hang up');
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as InstanceType<typeof TransportError>).kind).toBe('network_timeout');

    // The failed operation should not have poisoned the client permanently -- the next call
    // reconnects and can succeed.
    await expect(client.useInbox(async () => 'recovered')).resolves.toBe('recovered');
    expect(FakeImapFlow.connectCallCount).toBe(2);
  });
});
