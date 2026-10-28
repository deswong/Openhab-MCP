import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { OpenHabClient } from '../openhab-client.js';

describe('OpenHabClient', () => {
  let client: OpenHabClient;
  let mock: MockAdapter;
  const baseUrl = 'http://openhab:8080';
  const apiToken = 'fake-token';

  beforeEach(() => {
    mock = new MockAdapter(axios as ConstructorParameters<typeof MockAdapter>[0]);
    client = new OpenHabClient(baseUrl, apiToken, { enableSSE: false });
  });

  afterEach(() => {
    mock.restore();
  });

  describe('Items', () => {
    it('should fetch items', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(200, [{ name: 'Item1' }]);
      expect(await client.getItems()).toEqual([{ name: 'Item1' }]);
    });

    it('should fetch a single item', async () => {
      mock.onGet(`${baseUrl}/rest/items/Item1`).reply(200, { name: 'Item1' });
      expect(await client.getItem('Item1')).toEqual({ name: 'Item1' });
    });

    it('should send a command', async () => {
      mock.onPost(`${baseUrl}/rest/items/Item1`).reply(200, 'OK');
      expect(await client.sendCommand('Item1', 'ON')).toBe('OK');
    });

    it('should fetch persistence data with parameters', async () => {
      mock.onGet(`${baseUrl}/rest/persistence/items/Item1`).reply(200, {});
      await client.getItemPersistenceData('Item1', 'service', 'start', 'end');
      expect(mock.history.get[0].params.serviceId).toBe('service');
      expect(mock.history.get[0].params.starttime).toBe('start');
      expect(mock.history.get[0].params.endtime).toBe('end');
    });

    it('should store persistence data with serviceId', async () => {
      mock.onPut(`${baseUrl}/rest/persistence/items/Item1`).reply(200);
      await client.storeItemPersistenceData('Item1', 'now', 'ON', 's1');
      expect(mock.history.put[0].params.serviceId).toBe('s1');
    });

    it('should update state', async () => {
      mock.onPut(`${baseUrl}/rest/items/Item1/state`).reply(200, 'OK');
      expect(await client.updateState('Item1', 'ON')).toBe('OK');
    });

    it('should create or update item', async () => {
      mock.onPut(`${baseUrl}/rest/items/Item1`).reply(200);
      await client.createOrUpdateItem('Item1', { type: 'Switch' });
      expect(mock.history.put[0].data).toContain('Switch');
    });

    it('should delete item', async () => {
      mock.onDelete(`${baseUrl}/rest/items/Item1`).reply(200);
      await client.deleteItem('Item1');
      expect(mock.history.delete.length).toBe(1);
    });

    it('should manage tags', async () => {
      mock.onPut(`${baseUrl}/rest/items/Item1/tags/T1`).reply(200);
      mock.onDelete(`${baseUrl}/rest/items/Item1/tags/T1`).reply(200);
      await client.addTag('Item1', 'T1');
      await client.removeTag('Item1', 'T1');
      expect(mock.history.put.length).toBe(1);
      expect(mock.history.delete.length).toBe(1);
    });

    it('should manage metadata', async () => {
      mock.onPut(`${baseUrl}/rest/items/Item1/metadata/ns`).reply(200);
      mock.onDelete(`${baseUrl}/rest/items/Item1/metadata/ns`).reply(200);
      await client.setMetadata('Item1', 'ns', 'val', { c: 1 });
      await client.removeMetadata('Item1', 'ns');
      expect(mock.history.put[0].data).toContain('val');
      expect(mock.history.delete.length).toBe(1);
    });
  });

  describe('Things', () => {
    it('should manage things', async () => {
      mock.onGet(`${baseUrl}/rest/things`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/things/t1`).reply(200, { UID: 't1' });
      mock.onPost(`${baseUrl}/rest/things`).reply(200, { UID: 't2' });
      mock.onPut(`${baseUrl}/rest/things/t1`).reply(200);
      mock.onDelete(`${baseUrl}/rest/things/t1`).reply(200);
      mock.onPut(`${baseUrl}/rest/things/t1/enable`).reply(200);
      mock.onPut(`${baseUrl}/rest/things/t1/config`).reply(200);
      mock.onGet(`${baseUrl}/rest/things/t1/status`).reply(200, { status: 'ONLINE' });

      await client.getThings();
      await client.getThing('t1');
      await client.createThing({ label: 'new' });
      await client.updateThing('t1', { label: 'L' });
      await client.deleteThing('t1', true);
      await client.enableThing('t1', false);
      await client.updateThingConfig('t1', { k: 'v' });
      await client.getThingStatus('t1');

      expect(mock.history.get.length).toBe(3);
      expect(mock.history.post.length).toBe(1);
      expect(mock.history.put.length).toBe(3);
      expect(mock.history.delete[0].params.force).toBe(true);
    });
  });

  describe('Links', () => {
    it('should manage links', async () => {
      mock.onGet(`${baseUrl}/rest/links`).reply(200, []);
      mock.onPut(`${baseUrl}/rest/links/i/c`).reply(200);
      mock.onDelete(`${baseUrl}/rest/links/i/c`).reply(200);

      await client.getLinks('i');
      await client.linkItemToChannel('i', 'c', { c: 1 });
      await client.unlinkItemFromChannel('i', 'c');

      expect(mock.history.get[0].params.itemName).toBe('i');
      expect(mock.history.put.length).toBe(1);
      expect(JSON.parse(mock.history.put[0].data)).toEqual({
        itemName: 'i',
        channelUID: 'c',
        configuration: { c: 1 },
      });
      expect(mock.history.delete.length).toBe(1);
    });

    it('should include the link identity when applying a profile', async () => {
      mock.onPut(`${baseUrl}/rest/links/i/c`).reply(200);

      await client.configureLinkProfile('i', 'c', 'system:follow', { param: 'value' });

      expect(JSON.parse(mock.history.put[0].data)).toEqual({
        itemName: 'i',
        channelUID: 'c',
        configuration: { profile: 'system:follow', param: 'value' },
      });
    });
  });

  describe('Semantic Tags', () => {
    it('should manage semantic tags', async () => {
      mock.onGet(`${baseUrl}/rest/tags`).reply(200, []);
      mock.onPost(`${baseUrl}/rest/tags`).reply(200);
      mock.onGet(`${baseUrl}/rest/tags/id`).reply(200, {});
      mock.onPut(`${baseUrl}/rest/tags/id`).reply(200);
      mock.onDelete(`${baseUrl}/rest/tags/id`).reply(200);

      await client.getSemanticTags();
      await client.createSemanticTag({ id: 'id', label: 'L' });
      await client.getSemanticTag('id');
      await client.updateSemanticTag('id', { id: 'id', label: 'L2' });
      await client.deleteSemanticTag('id');

      expect(mock.history.get.length).toBe(2);
      expect(mock.history.post.length).toBe(1);
      expect(mock.history.put.length).toBe(1);
      expect(mock.history.delete.length).toBe(1);
    });
  });

  describe('Rules', () => {
    it('should manage rules', async () => {
      mock.onGet(`${baseUrl}/rest/rules`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/rules/r1`).reply(200, { uid: 'r1' });
      mock.onPost(`${baseUrl}/rest/rules`).reply(200, { uid: 'r2' });
      mock.onPut(`${baseUrl}/rest/rules/r1`).reply(200, { uid: 'r1' });
      mock.onDelete(`${baseUrl}/rest/rules/r1`).reply(200);

      await client.getRules();
      await client.getRule('r1');
      await client.createRule({ name: 'new' });
      await client.updateRule('r1', { name: 'updated' });
      await client.deleteRule('r1');

      expect(mock.history.get.length).toBe(2);
      expect(mock.history.post.length).toBe(1);
      expect(mock.history.put.length).toBe(1);
      expect(mock.history.delete.length).toBe(1);
    });

    it('should run a rule', async () => {
      mock.onPost(`${baseUrl}/rest/rules/rule1/runnow`).reply(200);
      await client.runRule('rule1');
      expect(mock.history.post.length).toBe(1);
    });

    it('should run a rule with context', async () => {
      mock.onPost(`${baseUrl}/rest/rules/rule1/runnow`).reply(200);
      await client.runRule('rule1', { key: 'val' });
      expect(JSON.parse(mock.history.post[0].data)).toEqual({ key: 'val' });
    });

    it('should enable or disable a rule', async () => {
      mock.onPost(`${baseUrl}/rest/rules/rule1/enable`).reply(200);
      await client.enableRule('rule1', true);
      expect(mock.history.post[0].data).toBe('true');
    });
  });

  describe('Inbox', () => {
    it('should fetch inbox', async () => {
      mock.onGet(`${baseUrl}/rest/inbox`).reply(200, []);
      await client.getInbox();
      expect(mock.history.get.length).toBe(1);
    });

    it('should manage inbox', async () => {
      mock.onPost(`${baseUrl}/rest/inbox/t/ignore`).reply(200);
      mock.onPost(`${baseUrl}/rest/inbox/t/unignore`).reply(200);
      await client.ignoreInboxItem('t');
      await client.unignoreInboxItem('t');
      expect(mock.history.post.length).toBe(2);
    });

    it('should approve inbox item with optional params', async () => {
      mock.onPost(`${baseUrl}/rest/inbox/t/approve`).reply(200);
      await client.approveInboxItem('t', 'label', 'newId');
      expect(mock.history.post[0].data).toBe('label');
      expect(mock.history.post[0].params.newThingId).toBe('newId');
    });

    it('should approve inbox item without params (covers defaults)', async () => {
      mock.onPost(`${baseUrl}/rest/inbox/t/approve`).reply(200);
      await client.approveInboxItem('t');
      expect(mock.history.post[0].data).toBe('');
      expect(mock.history.post[0].params).toEqual({});
    });
  });

  describe('Voice & Audio', () => {
    it('should manage voice and audio', async () => {
      mock.onPost(`${baseUrl}/rest/voice/say`).reply(200);
      mock.onPost(`${baseUrl}/rest/voice/interpreters`).reply(200);
      mock.onGet(`${baseUrl}/rest/voice/voices`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/audio/sinks`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/audio/sources`).reply(200, []);

      await client.voiceSay('hello', 'v1', 's1', '100');
      await client.voiceInterpret('hi');
      await client.getVoices();
      await client.getAudioSinks();
      await client.getAudioSources();

      expect(mock.history.post.length).toBe(2);
      expect(mock.history.get.length).toBe(3);
    });
  });

  describe('System & Misc', () => {
    it('should cover system methods', async () => {
      mock.onGet(`${baseUrl}/rest/persistence`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/addons`).reply(200, []);
      mock.onPost(`${baseUrl}/rest/addons/a1/install`).reply(200);
      mock.onPost(`${baseUrl}/rest/addons/a1/uninstall`).reply(200);
      mock.onGet(`${baseUrl}/rest/sitemaps`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/ui/components/n`).reply(200, {});
      mock.onGet(`${baseUrl}/rest/ui/tiles`).reply(200, {});
      mock.onGet(`${baseUrl}/rest/systeminfo`).reply(200, {});
      mock.onGet(`${baseUrl}/rest/logging`).reply(200, []);
      mock.onPut(`${baseUrl}/rest/logging/l`).reply(200);
      mock.onGet(`${baseUrl}/rest/services`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/services/s/config`).reply(200, {});
      mock.onPut(`${baseUrl}/rest/services/s/config`).reply(200);
      mock.onGet(`${baseUrl}/rest/templates`).reply(200, []);
      mock.onGet(`${baseUrl}/rest/transformations`).reply(200, []);
      mock.onPost(`${baseUrl}/rest/habot/chat`).reply(200, 'hi');

      await client.getPersistenceServices();
      await client.getAddons();
      await client.installAddon('a1');
      await client.uninstallAddon('a1');
      await client.getSitemaps();
      await client.getUIComponents('n');
      await client.getUITiles();
      await client.getSystemInfo();
      await client.getLoggers();
      await client.setLoggerLevel('l', 'INFO');
      await client.getServices();
      await client.getServiceConfig('s');
      await client.updateServiceConfig('s', { k: 1 });
      await client.getTemplates();
      await client.getTransformations();
      await client.chatWithHabot('hello');

      expect(mock.history.get.length).toBe(11);
      expect(mock.history.post.length).toBe(3);
      expect(mock.history.put.length).toBe(2);
    });
  });

  describe('Expert Tools', () => {
    it('should find equipment by type in a room', async () => {
      const mockItems = [
        { name: 'Room1', label: 'Living Room', tags: ['Location'] },
        { name: 'Light1', label: 'Ceiling Light', groupNames: ['Room1'], tags: ['Light'] },
        { name: 'PowerPoint', label: 'Power', groupNames: ['Light1'], tags: ['Point'] },
      ];
      mock.onGet(`${baseUrl}/rest/items`).reply(200, mockItems);

      const result = await client.findEquipmentByType('Living Room', 'Light');
      expect(result).toHaveLength(1);
      expect(result[0].equipment.name).toBe('Light1');
      expect(result[0].points).toHaveLength(1);
      expect(result[0].points[0].name).toBe('PowerPoint');
    });

    it('should calculate statistics for numeric items', async () => {
      mock.onGet(`${baseUrl}/rest/items/Temp`).reply(200, { name: 'Temp', type: 'Number' });
      mock.onGet(`${baseUrl}/rest/persistence/items/Temp`).reply(200, {
        name: 'Temp',
        data: [
          { time: '2024-01-01T00:00:00Z', state: '20' },
          { time: '2024-01-01T01:00:00Z', state: '22' },
          { time: '2024-01-01T02:00:00Z', state: '24' },
        ],
      });

      const stats = await client.getItemStatistics('Temp');
      expect(stats.type).toBe('numeric');
      expect(stats.average).toBe(22);
      expect(stats.min).toBe(20);
      expect(stats.max).toBe(24);
    });

    it('should calculate duty cycle for binary items', async () => {
      mock
        .onGet(`${baseUrl}/rest/items/Heater`)
        .reply(200, { name: 'Heater', type: 'Switch', state: 'OFF' });
      mock.onGet(`${baseUrl}/rest/persistence/items/Heater`).reply(200, {
        name: 'Heater',
        data: [
          { time: '2024-01-01T00:00:00Z', state: 'ON' },
          { time: '2024-01-01T01:00:00Z', state: 'OFF' },
          { time: '2024-01-01T02:00:00Z', state: 'OFF' },
        ],
      });

      const stats = await client.getItemStatistics('Heater');
      expect(stats.type).toBe('stateful');
      expect(stats.dutyCyclePercentage).toBe('50.00%'); // 1h ON out of 2h total
    });

    it('should normalize media controls', async () => {
      const mockItems = [
        { name: 'Speaker', label: 'Sonos', tags: ['Speaker'] },
        {
          name: 'Speaker_Vol',
          label: 'Volume',
          groupNames: ['Speaker'],
          type: 'Dimmer',
          state: '50',
        },
      ];
      mock.onGet(`${baseUrl}/rest/items`).reply(200, mockItems);
      mock.onPost(`${baseUrl}/rest/items/Speaker_Vol`).reply(200, 'ok');

      await client.controlMedia('Sonos', 'volume_up');
      expect(mock.history.post[0].data).toBe('60');
      await client.controlMedia('Sonos', 'volume_up');
      expect(mock.history.post[0].data).toBe('60');
    });

    it('should generate a concise system summary', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(200, [
        { name: 'L1', type: 'Switch', state: 'ON', tags: ['Location'] },
        { name: 'T1', type: 'Number', state: '25' },
      ]);
      mock.onGet(`${baseUrl}/rest/things`).reply(200, [
        { label: 'Thing1', statusInfo: { status: 'ONLINE' } },
        { label: 'Thing2', statusInfo: { status: 'OFFLINE' } },
      ]);

      const summary = await client.getSystemSummary();
      expect(summary.overview.totalItems).toBe(2);
      expect(summary.rooms).toContain('L1');
      expect(summary.systemIssues).toHaveLength(1);
    });

    it('should validate rule logic', async () => {
      const goodScript = 'items.getItem("L1").sendCommand("ON");';
      const badScript = 'while(true) { console.log("loop"); }';

      mock.onGet(`${baseUrl}/rest/items`).reply(200, [{ name: 'L1' }]);

      const goodResult = await client.validateRuleLogic(goodScript, 'application/javascript');
      const badResult = await client.validateRuleLogic(badScript, 'application/javascript');

      expect(goodResult.valid).toBe(true);
      expect(badResult.valid).toBe(false);
      expect(badResult.errors[0]).toContain('Infinite loop');
    });

    it('should generate TS boilerplate', async () => {
      mock
        .onGet(`${baseUrl}/rest/items`)
        .reply(200, [{ name: 'Light1', type: 'Switch', label: 'My Light' }]);

      const boilerplate = await client.generateSystemBoilerplate();
      expect(boilerplate).toContain('Light1: "ON" | "OFF"');
      expect(boilerplate).toContain('My Light');
    });

    it('should execute batch commands in parallel', async () => {
      mock.onPost(`${baseUrl}/rest/items/L1`).reply(200);
      mock.onPost(`${baseUrl}/rest/items/L2`).reply(200);

      const results = await client.executeBatch([
        { itemName: 'L1', command: 'ON' },
        { itemName: 'L2', command: 'OFF' },
      ]);

      expect(results).toHaveLength(2);
      expect(mock.history.post).toHaveLength(2);
    });

    it('should fuzzy search items', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(200, [
        { name: 'Kitchen_Light', type: 'Switch', labels: 'Kitchen' },
        { name: 'Lounge_Light', type: 'Switch' },
      ]);

      const results = await client.searchItems('Kitchen');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Kitchen_Light');
    });

    it('should generate minimal schema', async () => {
      mock
        .onGet(`${baseUrl}/rest/items`)
        .reply(200, [{ name: 'L1', type: 'Switch', label: 'Lamp' }]);

      const schema = await client.getSchema();
      expect(schema[0]).toEqual({ name: 'L1', type: 'Switch', label: 'Lamp' });
      expect(schema[0]).not.toHaveProperty('state');
    });

    it('should provide dynamic prompt context', async () => {
      mock
        .onGet(`${baseUrl}/rest/items`)
        .reply(200, [
          { name: 'L1', type: 'Switch', state: 'ON', tags: ['Location'], label: 'Living Room' },
        ]);
      mock.onGet(`${baseUrl}/rest/things`).reply(200, []);

      const context = await client.getPromptContext();
      expect(context).toContain('Living Room');
      expect(context).toContain('Managed Preference');
      expect(context).toContain('execute_batch');
    });

    it('should simulate shadow run', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(200, [{ name: 'L1', state: 'OFF' }]);
      const results = await client.shadowRun([{ itemName: 'L1', command: 'ON' }]);
      expect(results[0].oldState).toBe('OFF');
      expect(results[0].predictedState).toBe('ON');
    });

    it('should generate Mermaid topology', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(200, [
        { name: 'Room1', tags: ['Location'], label: 'Kitchen' },
        { name: 'Eq1', groupNames: ['Room1'], label: 'Fridge' },
      ]);
      const topology = await client.generateTopology();
      expect(topology).toContain('graph TD');
      expect(topology).toContain('Room1 --> Eq1');
    });

    it('should analyze system health', async () => {
      mock
        .onGet(`${baseUrl}/rest/things`)
        .reply(200, [{ UID: 'T1', label: 'Sensor', statusInfo: { status: 'OFFLINE' } }]);
      mock
        .onGet(`${baseUrl}/rest/items`)
        .reply(200, [{ name: 'Sensor_Battery', state: '10', label: 'Battery' }]);
      const health = await client.analyzeSystemHealth();
      expect(health.criticalIssues).toHaveLength(2);
      expect(health.criticalIssues[0]).toContain('OFFLINE');
      expect(health.criticalIssues[1]).toContain('Low Battery');
    });

    it('should generate rules from natural language', async () => {
      mock
        .onGet(`${baseUrl}/rest/items`)
        .reply(200, [{ name: 'Kitchen_Light', label: 'Kitchen Light' }]);
      const rule = await client.generateRuleFromNL('turn off the kitchen light');
      expect(rule.name).toContain('turn off');
      const actions = rule.actions as Array<{ configuration: { script: string } }>;
      expect(actions?.[0].configuration.script).toContain('Kitchen_Light');
      expect(actions?.[0].configuration.script).toContain('OFF');
    });

    it('should capture and activate scenes', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(200, [{ name: 'L1', state: 'OFF' }]);
      mock.onPost(`${baseUrl}/rest/items/L1`).reply(200);
      await client.captureScene('TestScene', ['L1']);

      const commands = await client.activateScene('TestScene');
      expect(commands[0]).toContain('L1');
      expect(commands[0]).toContain('OFF');
    });

    it('should generate ASCII visual charts', async () => {
      mock.onGet(`${baseUrl}/rest/persistence/items/TempSensor`).reply(200, {
        name: 'TempSensor',
        data: [
          { time: 1, state: '10' },
          { time: 2, state: '15' },
          { time: 3, state: '20' },
        ],
      });
      const chart = await client.getVisualChart('TempSensor');
      expect(chart).toContain('Trend for TempSensor');
      expect(chart).toContain('▄'); // Sparkline ticks for middle value
      expect(chart).toContain('█'); // Peak
    });

    it('should generate MainUI widget YAML', async () => {
      mock.onGet(`${baseUrl}/rest/items/Light1`).reply(200, {
        name: 'Light1',
        label: 'Ceiling Light',
        state: 'ON',
      });
      const yaml = await client.generateUIWidget('Light1');
      expect(yaml).toContain('oh-label-card');
      expect(yaml).toContain('item: Light1');
    });

    it('should suggest semantic tags', async () => {
      mock.onGet(`${baseUrl}/rest/items/Kitchen_Light`).reply(200, {
        name: 'Kitchen_Light',
        label: 'Kitchen Main Light',
      });
      const suggestion = await client.suggestSemanticTags('Kitchen_Light');
      expect(suggestion.suggestion).toContain('Kitchen');
      expect(suggestion.suggestion).toContain('Light');
      expect(suggestion.reasoning).toContain('Found keywords');
    });
  });

  describe('Error Handling', () => {
    it('should throw nice errors for API failures', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(404, { message: 'Not Found' });
      await expect(client.getItems()).rejects.toThrow(/OpenHAB API Error: 404/);
    });

    it('should add a hint for 401 errors on things endpoint', async () => {
      mock.onGet(`${baseUrl}/rest/things`).reply(401, { message: 'Unauthorized' });
      await expect(client.getThings()).rejects.toThrow(
        /require "Admin" or "Full Access" token scopes/
      );
    });

    it('should NOT add a hint for 401 errors on items endpoint', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(401, { message: 'Unauthorized' });
      const error = await client.getItems().catch((e) => e.message);
      expect(error).toContain('OpenHAB API Error: 401');
      expect(error).not.toContain('require "Admin" or "Full Access" token scopes');
    });

    it('should throw network errors', async () => {
      mock.onGet(`${baseUrl}/rest/items`).networkError();
      await expect(client.getItems()).rejects.toThrow(/OpenHAB (Network|Request) Error/);
    });
  });

  describe('Performance Optimizations', () => {
    it('should include compression headers', async () => {
      mock.onGet(`${baseUrl}/rest/items`).reply(200, []);
      await client.getItems();
      expect(mock.history.get[0].headers?.['Accept-Encoding']).toBe('gzip, deflate, br');
    });

    it('should cache metadata and avoid redundant network calls', async () => {
      mock.onGet(`${baseUrl}/rest/voice/voices`).reply(200, [{ id: 'v1' }]);

      // First call - network
      await client.getVoices();
      // Second call - cache
      await client.getVoices();

      expect(mock.history.get.length).toBe(1);
    });

    it('should invalidate cache on mutation', async () => {
      mock.onGet(`${baseUrl}/rest/tags`).reply(200, []);
      mock.onPost(`${baseUrl}/rest/tags`).reply(200);

      // Warm cache
      await client.getSemanticTags();
      expect(mock.history.get.length).toBe(1);

      // Mutate
      await client.createSemanticTag({ id: 'new', label: 'N' });

      // Second call - should trigger network again
      await client.getSemanticTags();
      expect(mock.history.get.length).toBe(2);
    });
  });
});
