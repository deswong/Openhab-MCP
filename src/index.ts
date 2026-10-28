import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { OpenHabClient } from './openhab-client.js';
import { registerTools } from './tools.js';

const openhabUrl = process.env.OPENHAB_URL;
const apiToken = process.env.OPENHAB_API_TOKEN;

if (!openhabUrl || !apiToken) {
  console.error('Error: OPENHAB_URL and OPENHAB_API_TOKEN environment variables are required.');
  console.error(
    'Example: OPENHAB_URL=http://openhab.localdomain:8080 OPENHAB_API_TOKEN=oh.mytoken node dist/index.js'
  );
  process.exit(1);
}

function createServer(openhabUrl: string, apiToken: string): McpServer {
  // Set up MCP Server
  const server = new McpServer({ name: 'openhab-mcp', version: '1.0.0' });

  // Initialize Client
  const client = new OpenHabClient(openhabUrl, apiToken);

  // --- Static Resources ---

  server.registerResource(
    'OpenHAB Items',
    'openhab://items',
    { description: 'A list of all items and their current states', mimeType: 'application/json' },
    async (_uri) => {
      const items = await client.getItems();
      return {
        contents: [
          {
            uri: 'openhab://items',
            mimeType: 'application/json',
            text: JSON.stringify(items),
          },
        ],
      };
    }
  );

  server.registerResource(
    'OpenHAB Things',
    'openhab://things',
    {
      description: 'A list of all configured things and their status',
      mimeType: 'application/json',
    },
    async (_uri) => {
      const things = await client.getThings();
      return {
        contents: [
          {
            uri: 'openhab://things',
            mimeType: 'application/json',
            text: JSON.stringify(things),
          },
        ],
      };
    }
  );

  server.registerResource(
    'OpenHAB Discovery Inbox',
    'openhab://discovery',
    {
      description: 'A list of discovered but unconfigured things in the inbox',
      mimeType: 'application/json',
    },
    async (_uri) => {
      const inbox = await client.getInbox();
      return {
        contents: [
          {
            uri: 'openhab://discovery',
            mimeType: 'application/json',
            text: JSON.stringify(inbox),
          },
        ],
      };
    }
  );

  server.registerResource(
    'OpenHAB System Summary',
    'openhab://summary',
    {
      description: 'A token-efficient overview of the system state for LLM context optimization',
      mimeType: 'application/json',
    },
    async (_uri) => {
      const summary = await client.getSystemSummary();
      return {
        contents: [
          {
            uri: 'openhab://summary',
            mimeType: 'application/json',
            text: JSON.stringify(summary),
          },
        ],
      };
    }
  );

  server.registerResource(
    'OpenHAB Item Schema',
    'openhab://schema',
    {
      description: 'Ultra-minimal list of item names and types for zero-token discovery',
      mimeType: 'application/json',
    },
    async (_uri) => {
      const schema = await client.getSchema();
      return {
        contents: [
          {
            uri: 'openhab://schema',
            mimeType: 'application/json',
            text: JSON.stringify(schema),
          },
        ],
      };
    }
  );

  server.registerResource(
    'OpenHAB AI Prompt Context',
    'openhab://prompt-context',
    {
      description: 'Pre-baked system prompt fragment to prime any AI agent for this specific home',
      mimeType: 'text/markdown',
    },
    async (_uri) => {
      const context = await client.getPromptContext();
      return {
        contents: [{ uri: 'openhab://prompt-context', mimeType: 'text/markdown', text: context }],
      };
    }
  );

  // --- Resource Templates ---

  server.registerResource(
    'Specific OpenHAB Item',
    new ResourceTemplate('openhab://items/{name}', { list: undefined }),
    { description: 'Access a single item by its name', mimeType: 'application/json' },
    async (uri, variables) => {
      const itemName = String(variables.name);
      const item = await client.getItem(itemName);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(item),
          },
        ],
      };
    }
  );

  server.registerResource(
    'Specific OpenHAB Thing',
    new ResourceTemplate('openhab://things/{uid}', { list: undefined }),
    { description: 'Access a single thing by its UID', mimeType: 'application/json' },
    async (uri, variables) => {
      const thingUID = String(variables.uid);
      const thing = await client.getThing(thingUID);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(thing),
          },
        ],
      };
    }
  );

  server.registerResource(
    'Item Visual Telemetry',
    new ResourceTemplate('openhab://visual/charts/{item}', { list: undefined }),
    { description: 'ASCII Sparkline trend analysis for an item', mimeType: 'text/markdown' },
    async (uri, variables) => {
      const itemName = String(variables.item);
      const chart = await client.getVisualChart(itemName);
      return { contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: chart }] };
    }
  );

  // Register Tools
  registerTools(server, client);

  console.error(`[OpenHAB MCP] Server ready for ${openhabUrl}; cache warm-up runs in background.`);
  return server;
}

try {
  serveStdio(() => createServer(openhabUrl, apiToken), {
    onerror: (error) => console.error('Fatal MCP transport error:', error),
  });
} catch (error) {
  console.error('Fatal error:', error);
  process.exitCode = 1;
}
