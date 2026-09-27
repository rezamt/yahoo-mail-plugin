import type { FetchMessageObject, ImapFlow, MessageStructureObject } from 'imapflow';
import { ImapClient, TransportError, type ErrorKind } from '../transport/ImapClient.js';

/**
 * The shared result shape returned by every read-path method: `listInbox` and (in later stories)
 * `searchMessages` both return `{ ok: true, data }` on success or `{ ok: false, error }` on
 * failure. Defined once here and imported, never redefined per tool.
 */
export type MailResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: ErrorKind; message: string } };

/**
 * One Inbox message summary. `id` is the bare IMAP UID decimal string, `date` is ISO 8601 UTC,
 * and `snippet` is ~200 plain-text characters. Defined once here, imported everywhere else.
 */
export interface MessageSummary {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  readonly snippet: string;
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

const SNIPPET_LENGTH = 200;

/** Clamps a caller-supplied limit to `min(limit, MAX_LIST_LIMIT)`, defaulting to 20. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

function formatFrom(envelope: FetchMessageObject['envelope']): string {
  const first = envelope?.from?.[0];
  if (!first) {
    return '';
  }
  if (first.name && first.address) {
    return `${first.name} <${first.address}>`;
  }
  return first.address ?? first.name ?? '';
}

function formatDate(
  envelopeDate: Date | string | undefined,
  internalDate: Date | string | undefined
): string {
  const source = envelopeDate ?? internalDate;
  const parsed = source instanceof Date ? source : new Date(source ?? 0);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(0).toISOString();
  }
  return parsed.toISOString();
}

interface TextPartRef {
  readonly id: string;
  readonly isHtml: boolean;
  readonly encoding?: string | undefined;
}

/** Walks a BODYSTRUCTURE tree for the first plain-text leaf, falling back to the first HTML leaf. */
function findTextPart(structure: MessageStructureObject | undefined): TextPartRef | undefined {
  if (!structure) {
    return undefined;
  }

  let plainMatch: TextPartRef | undefined;
  let htmlMatch: TextPartRef | undefined;
  const queue: MessageStructureObject[] = [structure];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }
    if (node.childNodes && node.childNodes.length > 0) {
      queue.push(...node.childNodes);
      continue;
    }
    const type = (node.type ?? '').toLowerCase();
    const id = node.part ?? '1';
    if (type === 'text/plain' && !plainMatch) {
      plainMatch = { id, isHtml: false, encoding: node.encoding };
    } else if (type === 'text/html' && !htmlMatch) {
      htmlMatch = { id, isHtml: true, encoding: node.encoding };
    }
  }

  return plainMatch ?? htmlMatch;
}

function decodeQuotedPrintable(input: string): string {
  return input.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function decodeBodyPart(buffer: Buffer, encoding: string | undefined): string {
  const normalized = (encoding ?? '7bit').toLowerCase();
  if (normalized === 'base64') {
    const stripped = buffer.toString('utf8').replace(/\s+/g, '');
    return Buffer.from(stripped, 'base64').toString('utf8');
  }
  if (normalized === 'quoted-printable') {
    return decodeQuotedPrintable(buffer.toString('utf8'));
  }
  return buffer.toString('utf8');
}

function stripHtml(text: string): string {
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function toSnippet(raw: string, isHtml: boolean): string {
  const plain = isHtml ? stripHtml(raw) : raw;
  return plain.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
}

/** Best-effort ~200-character plain-text snippet; never throws -- falls back to `''`. */
async function fetchSnippet(
  imap: ImapFlow,
  uid: number,
  structure: MessageStructureObject | undefined
): Promise<string> {
  const part = findTextPart(structure);
  if (!part) {
    return '';
  }
  try {
    const message = await imap.fetchOne(uid, { bodyParts: [part.id] }, { uid: true });
    if (!message || !message.bodyParts) {
      return '';
    }
    const buffer = message.bodyParts.get(part.id);
    if (!buffer) {
      return '';
    }
    return toSnippet(decodeBodyPart(buffer, part.encoding), part.isHtml);
  } catch {
    return '';
  }
}

async function buildSummaries(imap: ImapFlow, limit: number): Promise<MessageSummary[]> {
  const mailbox = imap.mailbox;
  const exists = mailbox ? mailbox.exists : 0;
  if (!exists) {
    return [];
  }

  const start = Math.max(1, exists - limit + 1);
  const range = `${start}:*`;

  const fetched: FetchMessageObject[] = [];
  for await (const message of imap.fetch(range, {
    uid: true,
    envelope: true,
    flags: true,
    bodyStructure: true,
    internalDate: true,
  })) {
    fetched.push(message);
  }

  fetched.sort((a, b) => b.uid - a.uid);
  const newest = fetched.slice(0, limit);

  const summaries: MessageSummary[] = [];
  for (const message of newest) {
    const snippet = await fetchSnippet(imap, message.uid, message.bodyStructure);
    summaries.push({
      id: String(message.uid),
      from: formatFrom(message.envelope),
      subject: message.envelope?.subject ?? '',
      date: formatDate(message.envelope?.date, message.internalDate),
      unread: !(message.flags?.has('\\Seen') ?? false),
      snippet,
    });
  }

  return summaries;
}

/**
 * Concrete Yahoo Mail service -- the sole business-logic layer between `tools/` and
 * `transport/`. There is no `MailProvider` interface: this is the one implementation.
 */
export class YahooMailService {
  constructor(private readonly client: ImapClient) {}

  /**
   * Lists up to `min(limit, 100)` (default 20) most recent Inbox messages, newest first.
   */
  async listInbox(limit?: number): Promise<MailResult<MessageSummary[]>> {
    const effectiveLimit = clampLimit(limit);
    try {
      const data = await this.client.useInbox((imap) => buildSummaries(imap, effectiveLimit));
      return { ok: true, data };
    } catch (err) {
      if (err instanceof TransportError) {
        return { ok: false, error: { kind: err.kind, message: err.message } };
      }
      throw err;
    }
  }
}
