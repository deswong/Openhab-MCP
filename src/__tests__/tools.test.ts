import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { OpenHabClient } from '../openhab-client.js';
import { registerTools } from '../tools.js';

describe('MCP Tools Integration', () => {
  let mockServer: McpServer;
  let mockClient: OpenHabClient;
  const toolHandlers: Record<string, (arg: unknown) => Promise<unknown>> = {};

  beforeEach(() => {
    mockServer = {
      registerTool: vi.fn(
        (name: string, _config: unknown, handler: (arg: unknown) => Promise<unknown>) => {
          toolHandlers[name] = handler;
        }
      ),
    } as unknown as McpServer;

    const mockMethod = () => vi.fn().mockResolvedValue('ok');

    mockClient = {
      // Items
      getSystemSummary: mockMethod(),
      getItems: mockMethod(),
      getItem: mockMethod(),
      sendCommand: mockMethod(),
      updateState: mockMethod(),
      createOrUpdateItem: mockMethod(),
      deleteItem: mockMethod(),
      addTag: mockMethod(),
      removeTag: mockMethod(),
      setMetadata: mockMethod(),
      removeMetadata: mockMethod(),
      // Things
      getThings: mockMethod(),
      getThing: mockMethod(),
      createThing: mockMethod(),
      updateThing: mockMethod(),
      deleteThing: mockMethod(),
      enableThing: mockMethod(),
      getThingStatus: mockMethod(),
      updateThingConfig: mockMethod(),
      // Links
      getLinks: mockMethod(),
      linkItemToChannel: mockMethod(),
      unlinkItemFromChannel: mockMethod(),
      configureLinkProfile: mockMethod(),
      // Semantic Tags
      getSemanticTags: mockMethod(),
      createSemanticTag: mockMethod(),
      getSemanticTag: mockMethod(),
      updateSemanticTag: mockMethod(),
      deleteSemanticTag: mockMethod(),
      // Rules
      getRules: mockMethod(),
      getRule: mockMethod(),
      createRule: mockMethod(),
      updateRule: mockMethod(),
      deleteRule: mockMethod(),
      runRule: mockMethod(),
      enableRule: mockMethod(),
      // Persistence
      getPersistenceServices: mockMethod(),
      getItemPersistenceData: mockMethod(),
      storeItemPersistenceData: mockMethod(),
      // Inbox
      getInbox: mockMethod(),
      approveInboxItem: mockMethod(),
      ignoreInboxItem: mockMethod(),
      unignoreInboxItem: mockMethod(),
      // Voice
      voiceSay: mockMethod(),
      voiceInterpret: mockMethod(),
      getVoices: mockMethod(),
      getAudioSinks: mockMethod(),
      getAudioSources: mockMethod(),
      // Addons
      getAddons: mockMethod(),
      installAddon: mockMethod(),
      uninstallAddon: mockMethod(),
      // UI
      getSitemaps: mockMethod(),
      getUIComponents: mockMethod(),
      getUITiles: mockMethod(),
      // System
      getSystemInfo: mockMethod(),
      getLoggers: mockMethod(),
      setLoggerLevel: mockMethod(),
      getServices: mockMethod(),
      getServiceConfig: mockMethod(),
      updateServiceConfig: mockMethod(),
      getTemplates: mockMethod(),
      getTransformations: mockMethod(),
      chatWithHabot: mockMethod(),
      // Mastery
      searchItems: mockMethod(),
      analyzeSystemHealth: mockMethod(),
      generateTopology: mockMethod(),
      explainItemState: mockMethod(),
      executeBatch: mockMethod(),
      captureScene: mockMethod(),
      activateScene: mockMethod(),
      getPromptContext: mockMethod(),
      getRecentLogs: mockMethod(),
    } as unknown as OpenHabClient;

    registerTools(mockServer, mockClient);
  });

  describe('Tool Dispatch Matrix', () => {
    const testCases = [
      // --- Core Items (query_items) ---
      {
        tool: 'query_items',
        args: { action: 'all', tags: 't', type: 'S' },
        clientMethod: 'getItems',
        expectedArgs: ['t', 'S', undefined, undefined],
      },
      {
        tool: 'query_items',
        args: { action: 'get', itemName: 'i' },
        clientMethod: 'getItem',
        expectedArgs: ['i'],
      },
      {
        tool: 'query_items',
        args: { action: 'search', query: 'q' },
        clientMethod: 'searchItems',
        expectedArgs: ['q'],
      },
      {
        tool: 'send_command',
        args: { itemName: 'i', command: 'ON' },
        clientMethod: 'sendCommand',
        expectedArgs: ['i', 'ON'],
      },

      // --- Item Modifications (manage_item) ---
      {
        tool: 'manage_item',
        args: { action: 'update_state', itemName: 'i', state: 'ON' },
        clientMethod: 'updateState',
        expectedArgs: ['i', 'ON'],
      },
      {
        tool: 'manage_item',
        args: { action: 'create_or_update', itemName: 'i', itemData: { t: 'S' } },
        clientMethod: 'createOrUpdateItem',
        expectedArgs: ['i', { t: 'S' }],
      },
      {
        tool: 'manage_item',
        args: { action: 'delete', itemName: 'i' },
        clientMethod: 'deleteItem',
        expectedArgs: ['i'],
      },
      {
        tool: 'manage_item',
        args: { action: 'add_tag', itemName: 'i', tag: 't' },
        clientMethod: 'addTag',
        expectedArgs: ['i', 't'],
      },
      {
        tool: 'manage_item',
        args: { action: 'remove_tag', itemName: 'i', tag: 't' },
        clientMethod: 'removeTag',
        expectedArgs: ['i', 't'],
      },
      {
        tool: 'manage_item',
        args: {
          action: 'set_metadata',
          itemName: 'i',
          namespace: 'n',
          value: 'v',
          config: { c: 1 },
        },
        clientMethod: 'setMetadata',
        expectedArgs: ['i', 'n', 'v', { c: 1 }],
      },
      {
        tool: 'manage_item',
        args: { action: 'remove_metadata', itemName: 'i', namespace: 'n' },
        clientMethod: 'removeMetadata',
        expectedArgs: ['i', 'n'],
      },

      // --- Hardware & Things (query_things / manage_thing) ---
      {
        tool: 'query_things',
        args: { action: 'all' },
        clientMethod: 'getThings',
        expectedArgs: [],
      },
      {
        tool: 'query_things',
        args: { action: 'get', thingUID: 'u' },
        clientMethod: 'getThing',
        expectedArgs: ['u'],
      },
      {
        tool: 'query_things',
        args: { action: 'status', thingUID: 'u' },
        clientMethod: 'getThingStatus',
        expectedArgs: ['u'],
      },
      {
        tool: 'manage_thing',
        args: { action: 'create', thingData: { t: 1 } },
        clientMethod: 'createThing',
        expectedArgs: [{ t: 1 }],
      },
      {
        tool: 'manage_thing',
        args: { action: 'update', thingUID: 'u', thingData: { t: 2 } },
        clientMethod: 'updateThing',
        expectedArgs: ['u', { t: 2 }],
      },
      {
        tool: 'manage_thing',
        args: { action: 'delete', thingUID: 'u', force: true },
        clientMethod: 'deleteThing',
        expectedArgs: ['u', true],
      },
      {
        tool: 'manage_thing',
        args: { action: 'enable', thingUID: 'u' },
        clientMethod: 'enableThing',
        expectedArgs: ['u', true],
      },
      {
        tool: 'manage_thing',
        args: { action: 'disable', thingUID: 'u' },
        clientMethod: 'enableThing',
        expectedArgs: ['u', false],
      },
      {
        tool: 'manage_thing',
        args: { action: 'configure', thingUID: 'u', config: { c: 1 } },
        clientMethod: 'updateThingConfig',
        expectedArgs: ['u', { c: 1 }],
      },

      // --- Rules & Automation (query_rules / manage_rule) ---
      { tool: 'query_rules', args: { action: 'all' }, clientMethod: 'getRules', expectedArgs: [] },
      {
        tool: 'query_rules',
        args: { action: 'get', ruleUID: 'u' },
        clientMethod: 'getRule',
        expectedArgs: ['u'],
      },
      {
        tool: 'manage_rule',
        args: { action: 'create', ruleData: { r: 1 } },
        clientMethod: 'createRule',
        expectedArgs: [{ r: 1 }],
      },
      {
        tool: 'manage_rule',
        args: { action: 'update', ruleUID: 'u', ruleData: { r: 2 } },
        clientMethod: 'updateRule',
        expectedArgs: ['u', { r: 2 }],
      },
      {
        tool: 'manage_rule',
        args: { action: 'delete', ruleUID: 'u' },
        clientMethod: 'deleteRule',
        expectedArgs: ['u'],
      },
      {
        tool: 'manage_rule',
        args: { action: 'enable', ruleUID: 'u' },
        clientMethod: 'enableRule',
        expectedArgs: ['u', true],
      },
      {
        tool: 'manage_rule',
        args: { action: 'disable', ruleUID: 'u' },
        clientMethod: 'enableRule',
        expectedArgs: ['u', false],
      },
      {
        tool: 'manage_rule',
        args: { action: 'run', ruleUID: 'u' },
        clientMethod: 'runRule',
        expectedArgs: ['u'],
      },

      // --- Links (manage_link) ---
      {
        tool: 'manage_link',
        args: { action: 'link', itemName: 'i', channelUID: 'c', config: { k: 1 } },
        clientMethod: 'linkItemToChannel',
        expectedArgs: ['i', 'c', { k: 1 }],
      },
      {
        tool: 'manage_link',
        args: { action: 'unlink', itemName: 'i', channelUID: 'c' },
        clientMethod: 'unlinkItemFromChannel',
        expectedArgs: ['i', 'c'],
      },
      {
        tool: 'manage_link',
        args: {
          action: 'configure',
          itemName: 'i',
          channelUID: 'c',
          profile: 'p',
          profileConfig: { k: 1 },
        },
        clientMethod: 'configureLinkProfile',
        expectedArgs: ['i', 'c', 'p', { k: 1 }],
      },

      // --- UI & Add-ons (manage_ui) ---
      {
        tool: 'manage_ui',
        args: { action: 'semantic_tags' },
        clientMethod: 'getSemanticTags',
        expectedArgs: [],
      },
      {
        tool: 'manage_ui',
        args: { action: 'create_tag', tagData: { id: 't' } },
        clientMethod: 'createSemanticTag',
        expectedArgs: [{ id: 't' }],
      },
      {
        tool: 'manage_ui',
        args: { action: 'update_tag', tagId: 't', tagData: { id: 't2' } },
        clientMethod: 'updateSemanticTag',
        expectedArgs: ['t', { id: 't2' }],
      },
      {
        tool: 'manage_ui',
        args: { action: 'delete_tag', tagId: 't' },
        clientMethod: 'deleteSemanticTag',
        expectedArgs: ['t'],
      },
      {
        tool: 'manage_ui',
        args: { action: 'install_addon', addonId: 'a' },
        clientMethod: 'installAddon',
        expectedArgs: ['a'],
      },
      {
        tool: 'manage_ui',
        args: { action: 'uninstall_addon', addonId: 'a' },
        clientMethod: 'uninstallAddon',
        expectedArgs: ['a'],
      },
      {
        tool: 'manage_ui',
        args: { action: 'inbox_approve', thingUID: 'u', label: 'l', newThingId: 'n' },
        clientMethod: 'approveInboxItem',
        expectedArgs: ['u', 'l', 'n'],
      },
      {
        tool: 'manage_ui',
        args: { action: 'inbox_ignore', thingUID: 'u' },
        clientMethod: 'ignoreInboxItem',
        expectedArgs: ['u'],
      },
      {
        tool: 'manage_ui',
        args: { action: 'inbox_unignore', thingUID: 'u' },
        clientMethod: 'unignoreInboxItem',
        expectedArgs: ['u'],
      },

      // --- System Management (manage_system) ---
      {
        tool: 'manage_system',
        args: { action: 'services' },
        clientMethod: 'getServices',
        expectedArgs: [],
      },
      {
        tool: 'manage_system',
        args: { action: 'logger_list' },
        clientMethod: 'getLoggers',
        expectedArgs: [],
      },
      {
        tool: 'manage_system',
        args: { action: 'service_config_get', serviceId: 's' },
        clientMethod: 'getServiceConfig',
        expectedArgs: ['s'],
      },
      {
        tool: 'manage_system',
        args: { action: 'service_config_update', serviceId: 's', config: { k: 1 } },
        clientMethod: 'updateServiceConfig',
        expectedArgs: ['s', { k: 1 }],
      },
      {
        tool: 'manage_system',
        args: { action: 'logger_set', loggerName: 'l', level: 'I' },
        clientMethod: 'setLoggerLevel',
        expectedArgs: ['l', 'I'],
      },
      {
        tool: 'manage_system',
        args: { action: 'audio_sinks' },
        clientMethod: 'getAudioSinks',
        expectedArgs: [],
      },
      {
        tool: 'manage_system',
        args: { action: 'audio_sources' },
        clientMethod: 'getAudioSources',
        expectedArgs: [],
      },
      {
        tool: 'manage_system',
        args: { action: 'voices' },
        clientMethod: 'getVoices',
        expectedArgs: [],
      },
      {
        tool: 'manage_system',
        args: { action: 'voice_say', text: 'h', sinkId: 's' },
        clientMethod: 'voiceSay',
        expectedArgs: ['h', undefined, 's'],
      },
      {
        tool: 'manage_system',
        args: { action: 'voice_interpret', text: 'h', interpreterIds: 'i' },
        clientMethod: 'voiceInterpret',
        expectedArgs: ['h', 'i'],
      },
      {
        tool: 'manage_system',
        args: { action: 'habot', text: 'h' },
        clientMethod: 'chatWithHabot',
        expectedArgs: ['h'],
      },

      // --- Scenes (manage_scene) ---
      {
        tool: 'manage_scene',
        args: { action: 'capture', name: 'n', itemNames: ['i'] },
        clientMethod: 'captureScene',
        expectedArgs: ['n', ['i']],
      },
      {
        tool: 'manage_scene',
        args: { action: 'activate', name: 'n' },
        clientMethod: 'activateScene',
        expectedArgs: ['n'],
      },

      // --- Logs (manage_logs) ---
      {
        tool: 'manage_logs',
        args: { action: 'recent', lines: 10 },
        clientMethod: 'getRecentLogs',
        expectedArgs: [10],
      },

      // --- Analysis (analyze_home / diagnose_item) ---
      {
        tool: 'analyze_home',
        args: { action: 'health' },
        clientMethod: 'analyzeSystemHealth',
        expectedArgs: [],
      },
      {
        tool: 'diagnose_item',
        args: { action: 'topology' },
        clientMethod: 'generateTopology',
        expectedArgs: [],
      },
      {
        tool: 'diagnose_item',
        args: { action: 'explain', itemName: 'i' },
        clientMethod: 'explainItemState',
        expectedArgs: ['i'],
      },

      // --- Batch (execute_batch) ---
      {
        tool: 'execute_batch',
        args: { commands: [{ itemName: 'i', command: 'c' }] },
        clientMethod: 'executeBatch',
        expectedArgs: [[{ itemName: 'i', command: 'c' }]],
      },

      // --- MCP status (mcp_status) ---
      {
        tool: 'mcp_status',
        args: { action: 'prompt_context' },
        clientMethod: 'getPromptContext',
        expectedArgs: [],
      },
    ];

    testCases.forEach(({ tool, args, clientMethod, expectedArgs }) => {
      it(`should dispatch ${tool} to client.${clientMethod}`, async () => {
        await toolHandlers[tool](args);
        expect(
          (mockClient as unknown as Record<string, MockInstance>)[clientMethod]
        ).toHaveBeenCalledWith(...expectedArgs);
      });
    });

    it('should register tool handlers through the SDK', () => {
      expect(mockServer.registerTool).toHaveBeenCalled();
      expect(toolHandlers.query_items).toBeTypeOf('function');
    });

    it('should provide structured content alongside readable text', async () => {
      const result = (await toolHandlers.get_system_summary({})) as {
        content: Array<{ text: string }>;
        structuredContent: { result: unknown };
      };

      expect(result.content[0].text).toBe('ok');
      expect(result.structuredContent.result).toBe('ok');
    });

    it('should handle tool execution errors', async () => {
      vi.mocked(mockClient.getItem).mockRejectedValue(new Error('API Failure'));
      const result = (await toolHandlers.query_items({ action: 'get', itemName: 'i' })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error executing tool query_items: API Failure');
      expect(result.structuredContent.error).toBe('API Failure');
    });

    it('should handle non-Error rejections', async () => {
      vi.mocked(mockClient.getItem).mockRejectedValue('String Failure');
      const result = (await toolHandlers.query_items({ action: 'get', itemName: 'i' })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.content[0].text).toContain('Error executing tool query_items: String Failure');
    });
  });
});
