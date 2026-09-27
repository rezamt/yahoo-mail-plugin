import { ImapFlow, type ImapFlowError, type MailboxObject } from 'imapflow';

/**
 * Thin wrapper over `imapflow` that owns the single serialized IMAP connection for the whole
 * process, Inbox's UIDVALIDITY tracking, connection-stage error classification, the
 * `connection_limit` retry, and all redaction/logging. This is the only module that ever sees a
 * raw `imapflow` exception -- every other layer only ever sees a {@link TransportError}.
 */

/** The fixed error taxonomy for the read path in this story. */
export type ErrorKind = 'auth' | 'network_timeout' | 'connection_limit';

const YAHOO_IMAP_HOST = 'imap.mail.yahoo.com';
const YAHOO_IMAP_PORT = 993;

/** Deliberate back-off before the single retry after a connection-limit refusal. */
const CONNECTION_LIMIT_RETRY_DELAY_MS = 5000;

const MESSAGES: Record<ErrorKind, string> = {
  network_timeout: "could not reach Yahoo's IMAP server -- network or TLS connection failed",
  connection_limit:
    'too many connections to this Yahoo account -- close other mail clients and try again',
  auth: 'invalid credentials -- check the App Password and account address',
};

const UNCLASSIFIED_AUTH_MESSAGE = 'server refused the connection';

/**
 * Error surfaced by {@link ImapClient} to every layer above `transport/`. Its `message` is always
 * one of a small set of fixed, safe strings -- never the raw `imapflow` exception, its message, or
 * its stack trace.
 */
export class TransportError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Was this error rejected during the LOGIN stage (as opposed to the TCP/TLS connect stage)? */
function isLoginStageError(err: ImapFlowError): boolean {
  return (
    Boolean(err.authenticationFailed) ||
    err.command === 'LOGIN' ||
    err.rejectedFrom === 'authenticate'
  );
}

const CONNECTION_LIMIT_PATTERN =
  /too many simultaneous connections|maximum number of connections|too many connections|connection limit/i;

const BAD_CREDENTIALS_PATTERN = /invalid|bad credentials|authentication failed|username and password/i;

/** Classifies a raw `imapflow` exception into the fixed taxonomy. Never returns `not_found`. */
function classify(err: ImapFlowError): ErrorKind {
  if (!isLoginStageError(err)) {
    return 'network_timeout';
  }

  const responseText = `${err.responseText ?? ''} ${err.serverResponseCode ?? ''}`;
  if (CONNECTION_LIMIT_PATTERN.test(responseText)) {
    return 'connection_limit';
  }
  return 'auth';
}

/** Builds the fixed, redacted message for a classified error -- never the server's raw text. */
function buildMessage(kind: ErrorKind, err: ImapFlowError): string {
  if (kind !== 'auth') {
    return MESSAGES[kind];
  }
  const responseText = `${err.responseText ?? ''} ${err.serverResponseCode ?? ''}`;
  const looksLikeBadCredentials =
    err.serverResponseCode === 'AUTHENTICATIONFAILED' || BAD_CREDENTIALS_PATTERN.test(responseText);
  return looksLikeBadCredentials ? MESSAGES.auth : UNCLASSIFIED_AUTH_MESSAGE;
}

function toTransportError(err: unknown): TransportError {
  const imapErr = err as ImapFlowError;
  const kind = classify(imapErr);
  return new TransportError(kind, buildMessage(kind, imapErr));
}

/** Best-effort, silent teardown of a connection we are about to abandon. Never throws. */
function closeQuietly(client: ImapFlow | undefined): void {
  if (!client) {
    return;
  }
  try {
    client.close();
  } catch {
    // Nothing to redact or report: this is cleanup of a connection we're discarding anyway.
  }
}

export interface ImapCredentials {
  readonly user: string;
  readonly pass: string;
}

export class ImapClient {
  private client: ImapFlow | undefined;
  private lastUidValidity: bigint | undefined;
  /** Memoizes an in-flight connect attempt so concurrent callers await one connection, never a pool. */
  private connecting: Promise<ImapFlow> | undefined;

  constructor(private readonly credentials: ImapCredentials) {}

  /** Inbox's last-seen UIDVALIDITY, recorded on the first successful SELECT INBOX. */
  get uidValidity(): bigint | undefined {
    return this.lastUidValidity;
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: YAHOO_IMAP_HOST,
      port: YAHOO_IMAP_PORT,
      secure: true,
      auth: { user: this.credentials.user, pass: this.credentials.pass },
      // This is the sole redaction/logging boundary: imapflow's own logger is disabled so it
      // never writes connection diagnostics (which can include response text) anywhere.
      logger: false,
      disableAutoIdle: true,
    });
  }

  /**
   * Connects and logs in exactly once, applying the connection_limit exception: a login refusal
   * classified as connection_limit gets one deliberate delayed retry of connect+login; every
   * other kind is single-attempt.
   */
  private async connectWithClassification(): Promise<ImapFlow> {
    const first = this.createClient();
    try {
      await first.connect();
      return first;
    } catch (err) {
      closeQuietly(first);
      const classified = toTransportError(err);
      if (classified.kind !== 'connection_limit') {
        throw classified;
      }

      await delay(CONNECTION_LIMIT_RETRY_DELAY_MS);

      const retry = this.createClient();
      try {
        await retry.connect();
        return retry;
      } catch {
        // Still refused after the one retry: report connection_limit regardless of how the
        // retry itself failed.
        closeQuietly(retry);
        throw new TransportError('connection_limit', MESSAGES.connection_limit);
      }
    }
  }

  /**
   * Ensures a usable connection, reconnecting immediately (no delay) if the last one dropped.
   * Concurrent callers that both observe no usable connection share a single in-flight connect
   * attempt instead of each opening their own -- exactly one serialized connection, never a pool.
   */
  private async ensureConnected(): Promise<ImapFlow> {
    if (this.client && this.client.usable) {
      return this.client;
    }
    if (!this.connecting) {
      closeQuietly(this.client);
      this.connecting = this.connectWithClassification().finally(() => {
        this.connecting = undefined;
      });
    }
    this.client = await this.connecting;
    return this.client;
  }

  /**
   * Runs `op` against a freshly re-selected INBOX. Re-`SELECT`s INBOX before every operation,
   * records UIDVALIDITY as process-level state on the first successful SELECT, and translates any
   * `imapflow` failure into a {@link TransportError} before it can escape this module.
   */
  async useInbox<T>(op: (client: ImapFlow) => Promise<T>): Promise<T> {
    let client: ImapFlow;
    let mailbox: MailboxObject;
    try {
      client = await this.ensureConnected();
      mailbox = await client.mailboxOpen('INBOX');
    } catch (err) {
      closeQuietly(this.client);
      this.client = undefined;
      if (err instanceof TransportError) {
        throw err;
      }
      throw toTransportError(err);
    }

    if (this.lastUidValidity === undefined) {
      this.lastUidValidity = mailbox.uidValidity;
    }

    try {
      return await op(client);
    } catch (err) {
      closeQuietly(this.client);
      this.client = undefined;
      throw toTransportError(err);
    }
  }
}
