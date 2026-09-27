import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { YahooMailService } from '../mail/YahooMailService.js';

/**
 * MCP tool handler for `yahoo_list_inbox`. Thin by design: zod-validates the input, delegates to
 * `mail/`, and formats the MCP result. This module never imports `imapflow` -- it reaches IMAP
 * only through `YahooMailService`.
 */

export const TOOL_NAME = 'yahoo_list_inbox';

export const listInboxInputShape = {
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of messages to return (default 20, capped at 100).'),
};

export function registerListInboxTool(server: McpServer, mail: YahooMailService): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'List Yahoo Mail inbox',
      description:
        'Lists the most recent messages in the Yahoo Mail inbox, newest first (default 20, capped at 100).',
      inputSchema: listInboxInputShape,
    },
    async (args: { limit?: number }) => {
      const result = await mail.listInbox(args.limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    }
  );
}
