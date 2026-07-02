import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OpenHabClient } from './openhab-client.js';

// Pre-compiled Zod schemas for MCP tools
const resolveItemSchema = z.object({ query: z.string() });
const sendCommandSchema = z.object({ itemName: z.string(), command: z.string() });
const executeBatchSchema = z.object({
  commands: z.array(
    z.object({
      itemName: z.string(),
      command: z.string().optional(),
      state: z.string().optional(),
    })
  ),
});
const scheduleCommandSchema = z.object({ itemName: z.string(), command: z.string(), delayMs: z.number() });
const queryItemsSchema = z.object({
  action: z.enum([
    'all',
    'get',
    'multi',
    'search',
    'master_search',
    'room_inventory',
    'semantic_path',
    'neighbors',
    'schema',
  ]),
  itemName: z.string().optional(),
  itemNames: z.array(z.string()).optional(),
  query: z.string().optional(),
  roomName: z.string().optional(),
  tags: z.string().optional(),
  type: z.string().optional(),
  state: z.string().optional(),
  includeMetadata: z.boolean().optional(),
});
const queryThingsSchema = z.object({
  action: z.enum(['all', 'get', 'status']),
  thingUID: z.string().optional(),
});
const queryRulesSchema = z.object({
  action: z.enum(['all', 'get']),
  ruleUID: z.string().optional(),
});
const manageItemSchema = z.object({
  action: z.enum([
    'create_or_update',
    'delete',
    'update_state',
    'add_tag',
    'remove_tag',
    'set_metadata',
    'remove_metadata',
  ]),
  itemName: z.string(),
  itemData: z.record(z.string(), z.any()).optional(),
  state: z.string().optional(),
  tag: z.string().optional(),
  namespace: z.string().optional(),
  value: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
});
const manageThingSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'enable', 'disable', 'configure']),
  thingUID: z.string().optional(),
  thingData: z.record(z.string(), z.any()).optional(),
  config: z.record(z.string(), z.any()).optional(),
  force: z.boolean().optional(),
});
const manageRuleSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'enable', 'disable', 'run']),
  ruleUID: z.string().optional(),
  ruleData: z.record(z.string(), z.any()).optional(),
});
const manageLinkSchema = z.object({
  action: z.enum(['list', 'link', 'unlink', 'configure']),
  itemName: z.string().optional(),
  channelUID: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
  profile: z.string().optional(),
  profileConfig: z.record(z.string(), z.any()).optional(),
});
const manageSceneSchema = z.object({
  action: z.enum(['capture', 'activate']),
  name: z.string(),
  itemNames: z.array(z.string()).optional(),
});
const manageLogsSchema = z.object({
  action: z.enum(['set_folder', 'recent', 'historical', 'search']),
  folderPath: z.string().optional(),
  lines: z.number().optional(),
  search: z.string().optional(),
  query: z.string().optional(),
  logType: z.enum(['openhab', 'events']).optional(),
  maxResults: z.number().optional(),
});
const managePersistenceSchema = z.object({
  action: z.enum(['services', 'get_data', 'store_data', 'statistics', 'summarize']),
  itemName: z.string().optional(),
  serviceId: z.string().optional(),
  starttime: z.string().optional(),
  endtime: z.string().optional(),
  time: z.string().optional(),
  state: z.string().optional(),
});
const manageUiSchema = z.object({
  action: z.enum([
    'addons',
    'install_addon',
    'uninstall_addon',
    'sitemaps',
    'sitemap_to_main_ui',
    'ui_components',
    'ui_tiles',
    'generate_widget',
    'semantic_tags',
    'create_tag',
    'update_tag',
    'delete_tag',
    'inbox_list',
    'inbox_approve',
    'inbox_ignore',
    'inbox_unignore',
  ]),
  addonId: z.string().optional(),
  namespace: z.string().optional(),
  itemName: z.string().optional(),
  sitemapName: z.string().optional(),
  tagId: z.string().optional(),
  tagData: z.any().optional(),
  thingUID: z.string().optional(),
  label: z.string().optional(),
  newThingId: z.string().optional(),
});
const manageSystemSchema = z.object({
  action: z.enum([
    'system_info',
    'services',
    'service_config_get',
    'service_config_update',
    'logger_list',
    'logger_set',
    'transformations',
    'templates',
    'trigger_scan',
    'voice_say',
    'voice_interpret',
    'voices',
    'audio_sinks',
    'audio_sources',
    'habot',
  ]),
  serviceId: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
  loggerName: z.string().optional(),
  level: z.string().optional(),
  bindingId: z.string().optional(),
  text: z.string().optional(),
  sinkId: z.string().optional(),
  interpreterIds: z.string().optional(),
});
const analyzeHomeSchema = z.object({
  action: z.enum([
    'health',
    'safety_audit',
    'energy',
    'stale_items',
    'orphans',
    'semantic_audit',
    'rule_conflicts',
    'find_equipment',
    'voice_exposure',
  ]),
  days: z.number().optional(),
  roomName: z.string().optional(),
  equipmentType: z.string().optional(),
});
const diagnoseItemSchema = z.object({
  action: z.enum(['explain', 'topology']),
  itemName: z.string().optional(),
});
const automationSchema = z.object({
  action: z.enum(['generate_rule', 'discover_patterns', 'shadow_run', 'simulate', 'validate_rule']),
  intent: z.string().optional(),
  itemName: z.string().optional(),
  correlatedItemName: z.string().optional(),
  command: z.string().optional(),
  commands: z.array(z.object({ itemName: z.string(), command: z.string() })).optional(),
  script: z.string().optional(),
});
const remediateSchema = z.object({
  action: z.enum([
    'bulk_update',
    'create_equipment',
    'suggest_tags',
    'standardize_naming',
    'optimize_persistence',
    'export_snapshot',
    'boilerplate',
    'semantic_fix',
    'semantic_fix_all',
  ]),
  itemNames: z.array(z.string()).optional(),
  updates: z
    .object({
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      groupNames: z.array(z.string()).optional(),
    })
    .optional(),
  thingUID: z.string().optional(),
  roomGroup: z.string().optional(),
  itemName: z.string().optional(),
  parentName: z.string().optional(),
  parentRelation: z.enum(['hasLocation', 'isPartOf', 'isPointOf']).optional(),
  addTag: z.string().optional(),
  dryRun: z.boolean().optional(),
});
const controlMediaSchema = z.object({
  equipmentName: z.string(),
  action: z.enum(['play', 'pause', 'next', 'previous', 'volume_up', 'volume_down']),
});
const mcpStatusSchema = z.object({
  action: z.enum(['health', 'capabilities', 'prompt_context']),
});

export function registerTools(server: McpServer, client: OpenHabClient) {
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // ─── Tier 1: Core standalone ──────────────────────────────────────────
        {
          name: 'initial_discovery',
          description:
            'One-shot bootstrap: returns a compact guidance context with a room-grouped quick-reference of every item (name, type, live state). Call ONCE on first contact. Do NOT also call generate_home_blueprint or get_system_summary — this covers all discovery needs.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_system_summary',
          description: 'High-density snapshot of the OpenHAB system: items, things, rooms, health.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'generate_home_blueprint',
          description:
            'Full room-by-room Markdown guide of the home. Use for layout exploration or when a user explicitly asks for a home overview — NOT as a first step (use initial_discovery instead).',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'resolve_item',
          description:
            'PRIMARY item finder. Converts natural-language intent ("kitchen light", "front door sensor") into ranked matches with exact names, types, rooms, and live states. Call this BEFORE any other search.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        {
          name: 'send_command',
          description: 'Send a command (ON, OFF, numeric value, etc.) to a single item.',
          inputSchema: {
            type: 'object',
            properties: {
              itemName: { type: 'string' },
              command: { type: 'string' },
            },
            required: ['itemName', 'command'],
          },
        },
        {
          name: 'execute_batch',
          description:
            'Execute multiple commands in parallel. Use for "Goodnight", scene-like, or multi-device actions.',
          inputSchema: {
            type: 'object',
            properties: {
              commands: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    itemName: { type: 'string' },
                    command: { type: 'string', description: 'Send command (preferred)' },
                    state: { type: 'string', description: 'Direct state update (use when needed)' },
                  },
                  required: ['itemName'],
                },
              },
            },
            required: ['commands'],
          },
        },
        {
          name: 'schedule_command',
          description: 'Schedule a command to run after a delay (e.g. "turn off in 20 minutes").',
          inputSchema: {
            type: 'object',
            properties: {
              itemName: { type: 'string' },
              command: { type: 'string' },
              delayMs: { type: 'number', description: 'Delay in milliseconds' },
            },
            required: ['itemName', 'command', 'delayMs'],
          },
        },

        // ─── Tier 2: Query / Read ─────────────────────────────────────────────
        {
          name: 'query_items',
          description:
            'Read item data. action: all (list with optional filters), get (by name), multi (batch by names), search (fuzzy text), master_search (across items+things+rules), room_inventory, semantic_path, neighbors, schema.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'all',
                  'get',
                  'multi',
                  'search',
                  'master_search',
                  'room_inventory',
                  'semantic_path',
                  'neighbors',
                  'schema',
                ],
              },
              itemName: { type: 'string', description: 'Used by: get, semantic_path, neighbors' },
              itemNames: {
                type: 'array',
                items: { type: 'string' },
                description: 'Used by: multi',
              },
              query: { type: 'string', description: 'Used by: search, master_search' },
              roomName: { type: 'string', description: 'Used by: room_inventory' },
              tags: { type: 'string', description: 'Comma-separated tag filter (used by: all)' },
              type: { type: 'string', description: 'Item type filter (used by: all)' },
              state: { type: 'string', description: 'State equality filter (used by: all)' },
              includeMetadata: {
                type: 'boolean',
                description:
                  'Include full metadata in results (used by: all). Default false to reduce token usage.',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'query_things',
          description:
            'Read thing data. action: all (list all), get (by UID), status (status info).',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['all', 'get', 'status'] },
              thingUID: { type: 'string', description: 'Used by: get, status' },
            },
            required: ['action'],
          },
        },
        {
          name: 'query_rules',
          description: 'Read automation rules. action: all (list all), get (by UID).',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['all', 'get'] },
              ruleUID: { type: 'string', description: 'Used by: get' },
            },
            required: ['action'],
          },
        },

        // ─── Tier 3: CRUD Management ──────────────────────────────────────────
        {
          name: 'manage_item',
          description:
            'Modify items. action: create_or_update, delete, update_state, add_tag, remove_tag, set_metadata, remove_metadata.' +
            ' WARNING: Do NOT use create_or_update for semantic model fixes (parentage, hierarchy).' +
            ' Use remediate action=semantic_fix instead. create_or_update safely merges existing groupNames and tags on update, but semantic relationships (hasLocation, isPointOf, isPartOf) must go through semantic_fix.' +
            ' WARNING: Do NOT use create_or_update for semantic model fixes (parentage, hierarchy).' +
            ' Use remediate action=semantic_fix instead. create_or_update safely merges existing groupNames and tags on update, but semantic relationships (hasLocation, isPointOf, isPartOf) must go through semantic_fix.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'create_or_update',
                  'delete',
                  'update_state',
                  'add_tag',
                  'remove_tag',
                  'set_metadata',
                  'remove_metadata',
                ],
              },
              itemName: { type: 'string' },
              itemData: { type: 'object', description: 'Used by: create_or_update' },
              state: { type: 'string', description: 'Used by: update_state' },
              tag: { type: 'string', description: 'Used by: add_tag, remove_tag' },
              namespace: { type: 'string', description: 'Used by: set_metadata, remove_metadata' },
              value: { type: 'string', description: 'Used by: set_metadata' },
              config: { type: 'object', description: 'Used by: set_metadata' },
            },
            required: ['action', 'itemName'],
          },
        },
        {
          name: 'manage_thing',
          description: 'Manage things. action: create, update, delete, enable, disable, configure.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['create', 'update', 'delete', 'enable', 'disable', 'configure'],
              },
              thingUID: { type: 'string', description: 'Required for all except create' },
              thingData: { type: 'object', description: 'Used by: create, update' },
              config: { type: 'object', description: 'Used by: configure' },
              force: { type: 'boolean', description: 'Used by: delete' },
            },
            required: ['action'],
          },
        },
        {
          name: 'manage_rule',
          description:
            'Manage automation rules. action: create, update, delete, enable, disable, run.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['create', 'update', 'delete', 'enable', 'disable', 'run'],
              },
              ruleUID: { type: 'string', description: 'Required for all except create' },
              ruleData: { type: 'object', description: 'Used by: create, update' },
            },
            required: ['action'],
          },
        },
        {
          name: 'manage_link',
          description:
            'Manage item-channel links. action: list, link, unlink, configure (apply a link profile).',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['list', 'link', 'unlink', 'configure'] },
              itemName: { type: 'string', description: 'Required for: link, unlink, configure' },
              channelUID: { type: 'string', description: 'Required for: link, unlink, configure' },
              config: { type: 'object', description: 'Used by: link' },
              profile: { type: 'string', description: 'Used by: configure' },
              profileConfig: { type: 'object', description: 'Used by: configure' },
            },
            required: ['action'],
          },
        },
        {
          name: 'manage_scene',
          description:
            'Named scene management. action: capture (save current item states), activate (restore a saved scene).',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['capture', 'activate'] },
              name: { type: 'string', description: 'Scene name' },
              itemNames: {
                type: 'array',
                items: { type: 'string' },
                description: 'Used by: capture',
              },
            },
            required: ['action', 'name'],
          },
        },

        // ─── Tier 4: System Services ──────────────────────────────────────────
        {
          name: 'manage_logs',
          description:
            'OpenHAB log access. Logs are on the remote OpenHAB server — ask the user for the path and call set_folder first. action: set_folder, recent, historical, search.',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['set_folder', 'recent', 'historical', 'search'] },
              folderPath: { type: 'string', description: 'Used by: set_folder' },
              lines: { type: 'number', description: 'Used by: recent, historical' },
              search: { type: 'string', description: 'Text filter (used by: historical)' },
              query: { type: 'string', description: 'Used by: search' },
              logType: {
                type: 'string',
                enum: ['openhab', 'events'],
                description: 'Used by: search',
              },
              maxResults: { type: 'number', description: 'Used by: search' },
            },
            required: ['action'],
          },
        },
        {
          name: 'manage_persistence',
          description:
            'Persistence data operations. action: services (list), get_data, store_data, statistics, summarize.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['services', 'get_data', 'store_data', 'statistics', 'summarize'],
              },
              itemName: {
                type: 'string',
                description: 'Used by: get_data, store_data, statistics, summarize',
              },
              serviceId: {
                type: 'string',
                description: 'Persistence service ID (omit for default)',
              },
              starttime: { type: 'string', description: 'ISO8601 start time' },
              endtime: { type: 'string', description: 'ISO8601 end time' },
              time: { type: 'string', description: 'ISO8601 timestamp (used by: store_data)' },
              state: { type: 'string', description: 'State value to store (used by: store_data)' },
            },
            required: ['action'],
          },
        },
        {
          name: 'manage_ui',
          description:
            'UI, add-ons, sitemaps, semantic tags, and discovery inbox. action: addons, install_addon, uninstall_addon, sitemaps, sitemap_to_main_ui, ui_components, ui_tiles, generate_widget, semantic_tags, create_tag, update_tag, delete_tag, inbox_list, inbox_approve, inbox_ignore, inbox_unignore.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'addons',
                  'install_addon',
                  'uninstall_addon',
                  'sitemaps',
                  'sitemap_to_main_ui',
                  'ui_components',
                  'ui_tiles',
                  'generate_widget',
                  'semantic_tags',
                  'create_tag',
                  'update_tag',
                  'delete_tag',
                  'inbox_list',
                  'inbox_approve',
                  'inbox_ignore',
                  'inbox_unignore',
                ],
              },
              addonId: { type: 'string', description: 'Used by: install_addon, uninstall_addon' },
              namespace: { type: 'string', description: 'Used by: ui_components (e.g. ui:pages)' },
              itemName: { type: 'string', description: 'Used by: generate_widget' },
              sitemapName: { type: 'string', description: 'Used by: sitemap_to_main_ui' },
              tagId: { type: 'string', description: 'Used by: update_tag, delete_tag' },
              tagData: { type: 'object', description: 'Used by: create_tag, update_tag' },
              thingUID: {
                type: 'string',
                description: 'Used by: inbox_approve, inbox_ignore, inbox_unignore',
              },
              label: { type: 'string', description: 'Used by: inbox_approve' },
              newThingId: { type: 'string', description: 'Used by: inbox_approve' },
            },
            required: ['action'],
          },
        },
        {
          name: 'manage_system',
          description:
            'System config, loggers, voice/audio, and binding scans. action: system_info, services, service_config_get, service_config_update, logger_list, logger_set, transformations, templates, trigger_scan, voice_say, voice_interpret, voices, audio_sinks, audio_sources, habot.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'system_info',
                  'services',
                  'service_config_get',
                  'service_config_update',
                  'logger_list',
                  'logger_set',
                  'transformations',
                  'templates',
                  'trigger_scan',
                  'voice_say',
                  'voice_interpret',
                  'voices',
                  'audio_sinks',
                  'audio_sources',
                  'habot',
                ],
              },
              serviceId: {
                type: 'string',
                description: 'Used by: service_config_get, service_config_update',
              },
              config: { type: 'object', description: 'Used by: service_config_update' },
              loggerName: { type: 'string', description: 'Used by: logger_set' },
              level: { type: 'string', description: 'Used by: logger_set' },
              bindingId: { type: 'string', description: 'Used by: trigger_scan (e.g. hue, sonos)' },
              text: { type: 'string', description: 'Used by: voice_say, voice_interpret, habot' },
              sinkId: { type: 'string', description: 'Used by: voice_say' },
              interpreterIds: { type: 'string', description: 'Used by: voice_interpret' },
            },
            required: ['action'],
          },
        },

        // ─── Tier 5: Intelligence & Analysis ──────────────────────────────────
        {
          name: 'analyze_home',
          description:
            'Home-wide analysis. action: health (offline + battery), safety_audit, energy, stale_items, orphans (broken links),' +
            ' semantic_audit (returns structured SemanticIssue objects with issue type + safeFix suggestions — same logic as the OpenHAB MainUI model page),' +
            ' rule_conflicts, find_equipment (by room + type), voice_exposure (Google/Alexa mappings).',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'health',
                  'safety_audit',
                  'energy',
                  'stale_items',
                  'orphans',
                  'semantic_audit',
                  'rule_conflicts',
                  'find_equipment',
                  'voice_exposure',
                ],
              },
              days: {
                type: 'number',
                description: 'Staleness threshold in days (used by: stale_items)',
              },
              roomName: { type: 'string', description: 'Used by: find_equipment' },
              equipmentType: {
                type: 'string',
                description: 'Semantic keyword e.g. Light, Lock (used by: find_equipment)',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'diagnose_item',
          description:
            'Item diagnostics. action: explain (forensic state + rules + history), topology (Mermaid home graph).',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['explain', 'topology'] },
              itemName: { type: 'string', description: 'Required for: explain' },
            },
            required: ['action'],
          },
        },
        {
          name: 'automation',
          description:
            'Automation generation and testing. action: generate_rule (from NL), discover_patterns (temporal correlation), shadow_run (dry-run preview), simulate (predict outcome + rule chains), validate_rule (JS syntax check).',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'generate_rule',
                  'discover_patterns',
                  'shadow_run',
                  'simulate',
                  'validate_rule',
                ],
              },
              intent: {
                type: 'string',
                description: 'Natural language rule intent (used by: generate_rule)',
              },
              itemName: { type: 'string', description: 'Used by: simulate, discover_patterns' },
              correlatedItemName: { type: 'string', description: 'Used by: discover_patterns' },
              command: { type: 'string', description: 'Used by: simulate' },
              commands: {
                type: 'array',
                description: 'Used by: shadow_run',
                items: {
                  type: 'object',
                  properties: { itemName: { type: 'string' }, command: { type: 'string' } },
                  required: ['itemName', 'command'],
                },
              },
              script: { type: 'string', description: 'JS to validate (used by: validate_rule)' },
            },
            required: ['action'],
          },
        },
        {
          name: 'remediate',
          description:
            'Bulk remediation and generation.' +
            ' action: bulk_update (batch tags/groups), create_equipment (auto-provision from thing), suggest_tags, standardize_naming, optimize_persistence, export_snapshot, boilerplate (TS types).' +
            " semantic_fix: safely fix ONE item's semantic parent without touching other fields or groupNames \u2014 uses targeted REST endpoints (metadata only + additive group)." +
            ' semantic_fix_all: run full audit and auto-apply all safely fixable issues (dryRun=true for preview).',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'bulk_update',
                  'create_equipment',
                  'suggest_tags',
                  'standardize_naming',
                  'optimize_persistence',
                  'export_snapshot',
                  'boilerplate',
                  'semantic_fix',
                  'semantic_fix_all',
                ],
              },
              itemNames: {
                type: 'array',
                items: { type: 'string' },
                description: 'Used by: bulk_update',
              },
              updates: {
                type: 'object',
                description: 'Used by: bulk_update',
                properties: {
                  tags: { type: 'array', items: { type: 'string' } },
                  category: { type: 'string' },
                  groupNames: { type: 'array', items: { type: 'string' } },
                },
              },
              thingUID: { type: 'string', description: 'Used by: create_equipment' },
              roomGroup: {
                type: 'string',
                description: 'Target location group (used by: create_equipment)',
              },
              itemName: { type: 'string', description: 'Used by: suggest_tags, semantic_fix' },
              parentName: {
                type: 'string',
                description: 'Name of the parent item to link to (used by: semantic_fix)',
              },
              parentRelation: {
                type: 'string',
                enum: ['hasLocation', 'isPartOf', 'isPointOf'],
                description: 'Semantic relationship key (used by: semantic_fix)',
              },
              addTag: {
                type: 'string',
                description:
                  'Tag to add to the item (used by: semantic_fix as an alternative to parentName)',
              },
              dryRun: {
                type: 'boolean',
                description:
                  'Preview changes without applying them (used by: semantic_fix, semantic_fix_all)',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'control_media',
          description:
            'Control a media player equipment item. action: play, pause, next, previous, volume_up, volume_down.',
          inputSchema: {
            type: 'object',
            properties: {
              equipmentName: {
                type: 'string',
                description: 'Name or label of the media player equipment group',
              },
              action: {
                type: 'string',
                enum: ['play', 'pause', 'next', 'previous', 'volume_up', 'volume_down'],
              },
            },
            required: ['equipmentName', 'action'],
          },
        },
        {
          name: 'mcp_status',
          description:
            'MCP server metadata. action: health (SSE/cache metrics), capabilities, prompt_context (AI priming context for this home).',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['health', 'capabilities', 'prompt_context'] },
            },
            required: ['action'],
          },
        },
      ],
    };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        // ─── Core standalone ──────────────────────────────────────────────────
        case 'initial_discovery':
          result = await client.initialDiscovery();
          break;

        case 'get_system_summary':
          result = await client.getSystemSummary();
          break;

        case 'generate_home_blueprint':
          result = await client.generateHomeBlueprint();
          break;

        case 'resolve_item': {
          const { query } = resolveItemSchema.parse(args);
          result = await client.resolveItem(query);
          break;
        }

        case 'send_command': {
          const { itemName, command } = sendCommandSchema.parse(args);
          result = await client.sendCommand(itemName, command);
          break;
        }

        case 'execute_batch': {
          const { commands } = executeBatchSchema.parse(args);
          result = await client.executeBatch(commands);
          break;
        }

        case 'schedule_command': {
          const { itemName, command, delayMs } = scheduleCommandSchema.parse(args);
          result = await client.scheduleCommand(itemName, command, delayMs);
          break;
        }

        // ─── Query / Read ──────────────────────────────────────────────────────
        case 'query_items': {
          const parsed = queryItemsSchema.parse(args);

          switch (parsed.action) {
            case 'all':
              // Pass includeMetadata down to getItems so the fetch is slim by default.
              // getItems() only requests metadata from the OpenHAB API when explicitly needed,
              // so this controls both the network payload AND the cached response size.
              result = await client.getItems(
                parsed.tags,
                parsed.type,
                parsed.includeMetadata ? '.*' : undefined,
                parsed.state
              );
              break;
            case 'get':
              result = await client.getItem(parsed.itemName!);
              break;
            case 'multi':
              result = await client.getMultiItems(parsed.itemNames!);
              break;
            case 'search':
              result = await client.searchItems(parsed.query!);
              break;
            case 'master_search':
              result = await client.masterSearch(parsed.query!);
              break;
            case 'room_inventory':
              result = await client.getRoomInventory(parsed.roomName!);
              break;
            case 'semantic_path':
              result = await client.getSemanticPath(parsed.itemName!);
              break;
            case 'neighbors':
              result = await client.findNeighboringEquipment(parsed.itemName!);
              break;
            case 'schema':
              result = await client.getSchema();
              break;
          }
          break;
        }

        case 'query_things': {
          const { action, thingUID } = queryThingsSchema.parse(args);
          if (action === 'all') result = await client.getThings();
          else if (action === 'get') result = await client.getThing(thingUID!);
          else result = await client.getThingStatus(thingUID!);
          break;
        }

        case 'query_rules': {
          const { action, ruleUID } = queryRulesSchema.parse(args);
          result = action === 'all' ? await client.getRules() : await client.getRule(ruleUID!);
          break;
        }

        // ─── CRUD Management ───────────────────────────────────────────────────
        case 'manage_item': {
          const parsed = manageItemSchema.parse(args);

          switch (parsed.action) {
            case 'create_or_update':
              result = await client.createOrUpdateItem(parsed.itemName, parsed.itemData!);
              break;
            case 'delete':
              result = await client.deleteItem(parsed.itemName);
              break;
            case 'update_state':
              result = await client.updateState(parsed.itemName, parsed.state!);
              break;
            case 'add_tag':
              result = await client.addTag(parsed.itemName, parsed.tag!);
              break;
            case 'remove_tag':
              result = await client.removeTag(parsed.itemName, parsed.tag!);
              break;
            case 'set_metadata':
              result = await client.setMetadata(
                parsed.itemName,
                parsed.namespace!,
                parsed.value!,
                parsed.config
              );
              break;
            case 'remove_metadata':
              result = await client.removeMetadata(parsed.itemName, parsed.namespace!);
              break;
          }
          break;
        }

        case 'manage_thing': {
          const { action, thingUID, thingData, config, force } = manageThingSchema.parse(args);

          switch (action) {
            case 'create':
              result = await client.createThing(thingData!);
              break;
            case 'update':
              result = await client.updateThing(thingUID!, thingData!);
              break;
            case 'delete':
              result = await client.deleteThing(thingUID!, force);
              break;
            case 'enable':
              result = await client.enableThing(thingUID!, true);
              break;
            case 'disable':
              result = await client.enableThing(thingUID!, false);
              break;
            case 'configure':
              result = await client.updateThingConfig(thingUID!, config!);
              break;
          }
          break;
        }

        case 'manage_rule': {
          const { action, ruleUID, ruleData } = manageRuleSchema.parse(args);

          switch (action) {
            case 'create':
              result = await client.createRule(ruleData!);
              break;
            case 'update':
              result = await client.updateRule(ruleUID!, ruleData!);
              break;
            case 'delete':
              result = await client.deleteRule(ruleUID!);
              break;
            case 'enable':
              result = await client.enableRule(ruleUID!, true);
              break;
            case 'disable':
              result = await client.enableRule(ruleUID!, false);
              break;
            case 'run':
              result = await client.runRule(ruleUID!);
              break;
          }
          break;
        }

        case 'manage_link': {
          const { action, itemName, channelUID, config, profile, profileConfig } = manageLinkSchema.parse(args);

          if (action === 'list') result = await client.getLinks(itemName, channelUID);
          else if (action === 'link')
            result = await client.linkItemToChannel(itemName!, channelUID!, config);
          else if (action === 'unlink')
            result = await client.unlinkItemFromChannel(itemName!, channelUID!);
          else
            result = await client.configureLinkProfile(
              itemName!,
              channelUID!,
              profile!,
              profileConfig
            );
          break;
        }

        case 'manage_scene': {
          const { action, name, itemNames } = manageSceneSchema.parse(args);
          result =
            action === 'capture'
              ? await client.captureScene(name, itemNames!)
              : await client.activateScene(name);
          break;
        }

        // ─── System Services ───────────────────────────────────────────────────
        case 'manage_logs': {
          const parsed = manageLogsSchema.parse(args);

          switch (parsed.action) {
            case 'set_folder':
              client.setLogFolderPath(parsed.folderPath!);
              result = `Log folder path set to: ${parsed.folderPath}`;
              break;
            case 'recent':
              result = await client.getRecentLogs(parsed.lines);
              break;
            case 'historical':
              result = await client.getHistoricalLogs(parsed.lines, parsed.search);
              break;
            case 'search':
              result = await client.searchLogs(
                parsed.query!,
                parsed.logType as 'openhab' | 'events',
                parsed.maxResults
              );
              break;
          }
          break;
        }

        case 'manage_persistence': {
          const parsed = managePersistenceSchema.parse(args);

          switch (parsed.action) {
            case 'services':
              result = await client.getPersistenceServices();
              break;
            case 'get_data':
              result = await client.getItemPersistenceData(
                parsed.itemName!,
                parsed.serviceId,
                parsed.starttime,
                parsed.endtime
              );
              break;
            case 'store_data':
              await client.storeItemPersistenceData(
                parsed.itemName!,
                parsed.time!,
                parsed.state!,
                parsed.serviceId
              );
              result = `Stored state '${parsed.state}' for '${parsed.itemName}' at ${parsed.time}.`;
              break;
            case 'statistics':
              result = await client.getItemStatistics(
                parsed.itemName!,
                parsed.starttime,
                parsed.endtime,
                parsed.serviceId
              );
              break;
            case 'summarize':
              result = await client.summarizePersistenceRange(
                parsed.itemName!,
                parsed.starttime!,
                parsed.endtime!
              );
              break;
          }
          break;
        }

        case 'manage_ui': {
          const parsed = manageUiSchema.parse(args);

          switch (parsed.action) {
            case 'addons':
              result = await client.getAddons();
              break;
            case 'install_addon':
              result = await client.installAddon(parsed.addonId!);
              break;
            case 'uninstall_addon':
              result = await client.uninstallAddon(parsed.addonId!);
              break;
            case 'sitemaps':
              result = await client.getSitemaps();
              break;
            case 'sitemap_to_main_ui':
              result = await client.sitemapToMainUI(parsed.sitemapName!);
              break;
            case 'ui_components':
              result = await client.getUIComponents(parsed.namespace!);
              break;
            case 'ui_tiles':
              result = await client.getUITiles();
              break;
            case 'generate_widget':
              result = await client.generateUIWidget(parsed.itemName!);
              break;
            case 'semantic_tags':
              result = await client.getSemanticTags();
              break;
            case 'create_tag':
              result = await client.createSemanticTag(parsed.tagData!);
              break;
            case 'update_tag':
              result = await client.updateSemanticTag(parsed.tagId!, parsed.tagData!);
              break;
            case 'delete_tag':
              result = await client.deleteSemanticTag(parsed.tagId!);
              break;
            case 'inbox_list':
              result = await client.getInbox();
              break;
            case 'inbox_approve':
              result = await client.approveInboxItem(
                parsed.thingUID!,
                parsed.label,
                parsed.newThingId
              );
              break;
            case 'inbox_ignore':
              result = await client.ignoreInboxItem(parsed.thingUID!);
              break;
            case 'inbox_unignore':
              result = await client.unignoreInboxItem(parsed.thingUID!);
              break;
          }
          break;
        }

        case 'manage_system': {
          const parsed = manageSystemSchema.parse(args);

          switch (parsed.action) {
            case 'system_info':
              result = await client.getSystemInfo();
              break;
            case 'services':
              result = await client.getServices();
              break;
            case 'service_config_get':
              result = await client.getServiceConfig(parsed.serviceId!);
              break;
            case 'service_config_update':
              result = await client.updateServiceConfig(parsed.serviceId!, parsed.config!);
              break;
            case 'logger_list':
              result = await client.getLoggers();
              break;
            case 'logger_set':
              result = await client.setLoggerLevel(parsed.loggerName!, parsed.level!);
              break;
            case 'transformations':
              result = await client.getTransformations();
              break;
            case 'templates':
              result = await client.getTemplates();
              break;
            case 'trigger_scan':
              result = await client.triggerDiscoveryScan(parsed.bindingId!);
              break;
            case 'voice_say':
              result = await client.voiceSay(parsed.text!, undefined, parsed.sinkId);
              break;
            case 'voice_interpret':
              result = await client.voiceInterpret(parsed.text!, parsed.interpreterIds);
              break;
            case 'voices':
              result = await client.getVoices();
              break;
            case 'audio_sinks':
              result = await client.getAudioSinks();
              break;
            case 'audio_sources':
              result = await client.getAudioSources();
              break;
            case 'habot':
              result = await client.chatWithHabot(parsed.text!);
              break;
          }
          break;
        }

        // ─── Intelligence & Analysis ───────────────────────────────────────────
        case 'analyze_home': {
          const parsed = analyzeHomeSchema.parse(args);

          switch (parsed.action) {
            case 'health':
              result = await client.analyzeSystemHealth();
              break;
            case 'safety_audit':
              result = await client.auditSystemSafety();
              break;
            case 'energy':
              result = await client.calculateEnergyInsights();
              break;
            case 'stale_items':
              result = await client.getStaleItems(parsed.days);
              break;
            case 'orphans':
              result = await client.findOrphansAndBrokenLinks();
              break;
            case 'semantic_audit':
              result = await client.auditSemanticModel();
              break;
            case 'rule_conflicts':
              result = await client.detectRuleConflicts();
              break;
            case 'find_equipment':
              result = await client.findEquipmentByType(parsed.roomName!, parsed.equipmentType!);
              break;
            case 'voice_exposure':
              result = await client.auditVoiceExposure();
              break;
          }
          break;
        }

        case 'diagnose_item': {
          const { action, itemName } = diagnoseItemSchema.parse(args);
          result =
            action === 'explain'
              ? await client.explainItemState(itemName!)
              : await client.generateTopology();
          break;
        }

        case 'automation': {
          const parsed = automationSchema.parse(args);

          switch (parsed.action) {
            case 'generate_rule':
              result = await client.generateRuleFromNL(parsed.intent!);
              break;
            case 'discover_patterns':
              result = await client.discoverAutomationPatterns(
                parsed.itemName!,
                parsed.correlatedItemName!
              );
              break;
            case 'shadow_run':
              result = await client.shadowRun(parsed.commands!);
              break;
            case 'simulate':
              result = await client.simulateSystemState(parsed.itemName!, parsed.command!);
              break;
            case 'validate_rule':
              result = await client.validateRuleLogic(parsed.script!, 'application/javascript');
              break;
          }
          break;
        }

        case 'remediate': {
          const parsed = remediateSchema.parse(args);

          switch (parsed.action) {
            case 'bulk_update':
              result = await client.bulkItemRemediation(parsed.itemNames!, parsed.updates!);
              break;
            case 'create_equipment':
              result = await client.createEquipmentFromThing(parsed.thingUID!, parsed.roomGroup!);
              break;
            case 'suggest_tags':
              result = await client.suggestSemanticTags(parsed.itemName!);
              break;
            case 'standardize_naming':
              result = await client.standardizeNamingConvention();
              break;
            case 'optimize_persistence':
              result = await client.optimizePersistenceStrategy();
              break;
            case 'export_snapshot':
              result = await client.exportSystemSnapshot();
              break;
            case 'boilerplate':
              result = await client.generateSystemBoilerplate();
              break;
            case 'semantic_fix': {
              const opts: {
                setSemanticParent?: {
                  key: 'hasLocation' | 'isPartOf' | 'isPointOf';
                  parentName: string;
                };
                addTag?: string;
              } = {};
              if (parsed.parentName && parsed.parentRelation) {
                opts.setSemanticParent = {
                  key: parsed.parentRelation,
                  parentName: parsed.parentName,
                };
              } else if (parsed.addTag) {
                opts.addTag = parsed.addTag;
              } else {
                result = {
                  success: false,
                  message: 'semantic_fix requires parentName+parentRelation or addTag.',
                };
                break;
              }
              result = await client.fixSemanticIssue(
                parsed.itemName!,
                opts,
                parsed.dryRun ?? false
              );
              break;
            }
            case 'semantic_fix_all':
              result = await client.applySemanticAuditFixes(parsed.dryRun ?? false);
              break;
          }
          break;
        }

        case 'control_media': {
          const { equipmentName, action } = controlMediaSchema.parse(args);
          result = await client.controlMedia(equipmentName, action);
          break;
        }

        case 'mcp_status': {
          const { action } = mcpStatusSchema.parse(args);
          if (action === 'health') result = client.getMcpHealth();
          else if (action === 'capabilities') result = client.getMcpCapabilities();
          else result = await client.getPromptContext();
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool ${name}: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });
}
