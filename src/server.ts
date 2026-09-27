import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/loadConfig.js';
import { ImapClient } from './transport/ImapClient.js';
import { YahooMailService } from './mail/YahooMailService.js';
import { registerListInboxTool } from './tools/listInbox.js';

/** Constructs the wired-up MCP server: config -> ImapClient -> YahooMailService -> tools. */
export function buildServer(): McpServer {
  const config = loadConfig();
  const imapClient = new ImapClient({ user: config.accountEmail, pass: config.appPassword });
  const mailService = new YahooMailService(imapClient);

  const server = new McpServer({ name: 'yahoo-mail-plugin', version: '0.1.0' });
  registerListInboxTool(server, mailService);

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  // The only registered MCP transport: stdio. No HTTP/SSE, no hosted/remote mode.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run the server when this module is the process entry point, not when it's imported
// (e.g. by tests, or by anything reusing `buildServer()`).
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err: unknown) => {
    // Startup-only diagnostics (e.g. a missing env var). loadConfig's error messages never
    // contain a credential value, so this is safe to print.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
