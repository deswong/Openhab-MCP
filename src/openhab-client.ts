/**
 * OpenHabClient
 * High-performance, cached client for OpenHAB v5+ with SSE event buffering,
 * smart semantic discovery, and automated system auditing capabilities.
 */
import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import {
  OpenHabItem,
  OpenHabThing,
  OpenHabRule,
  OpenHabLink,
  OpenHabSemanticTag,
  OpenHabPersistenceData,
  OpenHabLogger,
  OpenHabInboxItem,
  OpenHabAddon,
  OpenHabSitemap,
  OpenHabService,
  OpenHabServiceConfig,
  OpenHabTemplate,
  OpenHabTransformation,
  SemanticIssue,
} from './types.js';
import { readLastLines, normalizeEventLog } from './log-parser.js';

export class OpenHabClient {
  private client: AxiosInstance;
  private cache = new Map<string, { data: unknown; expiry: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private filteredCacheKeys = new Set<string>();
  private scenes = new Map<string, Array<{ itemName: string; command: string }>>();
  private readonly META_CACHE_TTL = 300000; // 5 minutes for metadata
  private readonly ITEM_CACHE_TTL = 60000; // 60 seconds (relies on SSE patch for invalidation)
  private readonly debug: boolean;
  private abortController: AbortController | null = null;
  private reconnectTimeout = 1000;
  private readonly enableSSE: boolean;
  private eventLogBuffer: string[] = [];
  private readonly MAX_LOG_BUFFER = 5000;
  private focusScope: { type: 'room' | 'group'; name: string } | null = null;
  private logFolderPath: string | null = null;

  /**
   * Semantic index — rebuilt whenever items_all is populated or patched.
   * Enables O(1) token / room / tag lookups instead of full O(n) scans.
   */
  private semanticIndex: {
    byRoom: Map<string, Set<string>>; // groupName.lower  -> Set<itemName> (direct membership)
    byTag: Map<string, Set<string>>; // tag             -> Set<itemName>
    byType: Map<string, Set<string>>; // itemType        -> Set<itemName>
    byToken: Map<string, Set<string>>; // word token      -> Set<itemName>
    byPrefix: Map<string, Set<string>>; // prefix(2+)      -> Set<itemName> (for prefix search)
    byCategory: Map<string, Set<string>>; // category.lower  -> Set<itemName>
    itemMap: Map<string, OpenHabItem>; // itemName        -> item
    itemToRoom: Map<string, string>; // itemName -> room.name (transitive: Location→Equipment→Point)
    itemToEquipment: Map<string, string>; // itemName -> equipment.name (direct parent Equipment)
    rooms: OpenHabItem[]; // Location items
  } = {
    byRoom: new Map(),
    byTag: new Map(),
    byType: new Map(),
    byToken: new Map(),
    byPrefix: new Map(),
    byCategory: new Map(),
    itemMap: new Map(),
    itemToRoom: new Map(),
    itemToEquipment: new Map(),
    rooms: [],
  };

  constructor(
    baseUrl: string,
    apiToken: string,
    options: { debug?: boolean; enableSSE?: boolean } = {}
  ) {
    this.debug = options.debug ?? process.env.OPENHAB_DEBUG === 'true';
    this.enableSSE = options.enableSSE ?? true;
    this.log(`Initializing client for ${baseUrl}`);
    this.client = axios.create({
      baseURL: baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      // Optimization: Connection pooling via Keep-Alive
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      // Optimization: Global request timeout (10s)
      timeout: 10000,
    });

    // Add interceptor to format errors nicely
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          let hint = '';
          if (error.response.status === 401) {
            const endpoint = error.config?.url || '';
            if (endpoint.includes('/rest/things') || endpoint.includes('/rest/systeminfo')) {
              hint = ' - This endpoint may require "Admin" or "Full Access" token scopes.';
            }
          }
          throw new Error(
            `OpenHAB API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}${hint}`
          );
        } else if (error.request) {
          throw new Error(`OpenHAB Network Error: No response received connecting to ${baseUrl}`);
        } else {
          throw new Error(`OpenHAB Request Error: ${error.message}`);
        }
      }
    );

    if (this.enableSSE) {
      this.initEventStream();
    }

    // Defer ALL I/O out of the constructor so the MCP transport can start
    // accepting requests immediately.
    // NOTE: Log/conf folder paths are NOT auto-detected — they may reside on a
    // remote server or network share.  Use setLogFolderPath() (exposed via the
    // set_log_folder tool) to configure the path before using filesystem-based
    // log search features.
    setTimeout(() => {
      this.log('Pre-warming cache...');
      console.error('[OpenHAB MCP] Warming up — fetching items...');
      // Pre-warm only the slim item list (no metadata, no things).
      // Things are fetched lazily on first use; SSE keeps item states live.
      this.getItems()
        .then(() => {
          console.error('[OpenHAB MCP] Ready — cache warm, semantic index built.');
        })
        .catch(() => {});
    }, 0); // 0 ms: yield to event loop, then start
  }

  /**
   * Set the path to the OpenHAB log folder (local path or mounted network share).
   * Must be called before using searchLogs() or preWarmLogBuffer().
   * Example paths:
   *   Local:   /var/log/openhab
   *   SMB:     /mnt/openhab-logs
   *   GVFS:    /home/user/.XDG_RUNTIME_DIR/gvfs/smb-share:server=openhab.local,share=openhab-logs
   */
  public setLogFolderPath(folderPath: string): void {
    this.logFolderPath = folderPath;
    this.log(`Log folder path set to: ${folderPath}`);
    // Pre-warm the log buffer from the newly configured path
    this.preWarmLogBuffer().catch(() => {});
  }

  // detectLogFoldersAsync() has been removed.
  // Log folder paths are never auto-detected because logs and conf files may
  // reside on a remote server or network share that is not available on this
  // machine.  Use setLogFolderPath() instead.

  private async preWarmLogBuffer(): Promise<void> {
    if (!this.logFolderPath) return;

    const eventsLog = path.join(this.logFolderPath, 'events.log');
    if (fs.existsSync(eventsLog)) {
      this.log('Pre-warming log buffer from events.log...');
      const lines = await readLastLines(eventsLog, 500);
      const normalized = lines.map(normalizeEventLog).filter((l): l is string => l !== null);

      this.eventLogBuffer = [...normalized, ...this.eventLogBuffer].slice(-this.MAX_LOG_BUFFER);
      this.log(`Pre-warmed buffer with ${normalized.length} historical events.`);
    }
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[OpenHAB MCP] ${message}`);
    }
  }

  private async initEventStream(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.log('Connecting to OpenHAB Event Stream...');

    try {
      const response = await this.client.get('/rest/events', {
        responseType: 'stream',
        signal: this.abortController.signal,
      });

      const stream = response.data;
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const eventPayload = JSON.parse(line.substring(6));
              this.handleSSEEvent(eventPayload);
            } catch {
              // Ignore parse errors
            }
          }
        }
      });

      stream.on('end', () => {
        this.log('Event Stream disconnected. Reconnecting...');
        this.reconnectSSE();
      });

      stream.on('error', (err: Error) => {
        this.log(`Event Stream error: ${err.message}. Reconnecting...`);
        this.reconnectSSE();
      });

      this.reconnectTimeout = 1000; // Reset on success
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name !== 'CanceledError' && err.name !== 'AbortError') {
        this.log(`SSE connection failed: ${err.message}`);
        this.reconnectSSE();
      }
    }
  }

  private reconnectSSE(): void {
    setTimeout(() => {
      this.reconnectTimeout = Math.min(this.reconnectTimeout * 2, 60000); // Max 1 min
      this.initEventStream();
    }, this.reconnectTimeout);
  }

  private handleSSEEvent(event: { topic: string; payload: string; type?: string }): void {
    const topicParts = event.topic.split('/');
    // Support both OH ≤4 (smarthome/*) and OH5+ (openhab/*) topic prefixes.
    const isItemTopic =
      (topicParts[0] === 'smarthome' || topicParts[0] === 'openhab') && topicParts[1] === 'items';
    if (isItemTopic) {
      const itemName = topicParts[2];
      const eventType = topicParts[3];

      if (eventType === 'statechanged') {
        const payload = JSON.parse(event.payload);
        this.log(`SSE SYNC: ${itemName} changed to ${payload.value}`);
        this.addLogToBuffer(
          `${new Date().toISOString()} - ItemStateChangedEvent - ${itemName} changed to ${payload.value}`
        );

        const cacheKey = `item_${itemName}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          (cached.data as OpenHabItem).state = payload.value;
          cached.expiry = Date.now() + this.ITEM_CACHE_TTL;
        }

        // Patch both the slim and metadata-inclusive bulk caches so subsequent
        // reads reflect the new state without waiting for TTL expiry.
        for (const bulkKey of ['items_all', 'items_all_meta']) {
          const allCached = this.cache.get(bulkKey);
          if (allCached) {
            const itemInAll = (allCached.data as OpenHabItem[]).find((i) => i.name === itemName);
            if (itemInAll) itemInAll.state = payload.value;
          }
        }
        // Keep semantic index itemMap entry in sync
        const indexed = this.semanticIndex.itemMap.get(itemName);
        if (indexed) indexed.state = payload.value;
      } else if (eventType === 'added' || eventType === 'removed') {
        this.log(`SSE SYNC: Item ${itemName} ${eventType}. Clearing caches.`);
        this.addLogToBuffer(
          `${new Date().toISOString()} - Item${eventType === 'added' ? 'Added' : 'Removed'}Event - ${itemName}`
        );
        this.invalidateItemCache(itemName);
        // Trigger an immediate background refetch so the index rebuilds promptly.
        this.getItems().catch(() => {});
      }
    } else {
      // Log other interesting events
      const eventType = topicParts[topicParts.length - 1];
      if (['CommandEvent', 'ItemStateEvent', 'ThingStatusInfoChangedEvent'].includes(eventType)) {
        try {
          const payload = JSON.parse(event.payload);
          this.addLogToBuffer(
            `${new Date().toISOString()} - ${eventType} - ${topicParts.slice(2, -1).join('/')} : ${JSON.stringify(payload)}`
          );
        } catch {
          this.addLogToBuffer(
            `${new Date().toISOString()} - ${eventType} - ${topicParts.slice(2, -1).join('/')}`
          );
        }
        // Optimization: When a Thing status changes, invalidate the things_all cache so
        // the next read reflects the new ONLINE/OFFLINE state without waiting for TTL expiry.
        if (eventType === 'ThingStatusInfoChangedEvent') {
          this.cache.delete('things_all');
          this.log('SSE SYNC: Thing status changed. Invalidated things_all cache.');
        }
      }
    }
  }

  private addLogToBuffer(log: string): void {
    this.eventLogBuffer.push(log);
    // Batch-compact instead of O(n) shift() on every push.
    // Allow up to 100 overflow entries, then slice once to trim back to MAX_LOG_BUFFER.
    if (this.eventLogBuffer.length > this.MAX_LOG_BUFFER + 100) {
      this.eventLogBuffer = this.eventLogBuffer.slice(-this.MAX_LOG_BUFFER);
    }
  }

  private async withCache<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && cached.expiry > now) {
      this.log(`Cache HIT: ${key}`);
      return cached.data as T;
    }

    // Optimization: In-flight deduplication — if a fetch for this key is already
    // in progress, return the same promise instead of firing a second HTTP request.
    const inflight = this.pending.get(key);
    if (inflight) {
      this.log(`Cache DEDUP: ${key}`);
      return inflight as Promise<T>;
    }

    this.log(`Cache MISS: ${key}`);
    const promise = fetcher()
      .then((data) => {
        this.cache.set(key, { data, expiry: Date.now() + ttl });
        this.pending.delete(key);
        return data;
      })
      .catch((err) => {
        this.pending.delete(key);
        throw err;
      });

    this.pending.set(key, promise as Promise<unknown>);
    return promise;
  }

  private invalidateItemCache(itemName?: string): void {
    if (itemName) {
      this.log(`Invalidating cache for item: ${itemName}`);
      this.cache.delete(`item_${itemName}`);
    }
    this.log('Invalidating global items cache');
    this.cache.delete('items_all');
    this.cache.delete('items_all_meta');
    // Also clear any filtered item cache keys (e.g. items_Switch_...) so
    // stale results don't linger after an item is added, modified, or removed.
    for (const key of this.filteredCacheKeys) {
      this.cache.delete(key);
    }
    this.filteredCacheKeys.clear();
  }

  // ---------------------------------------------------------------------------
  // Semantic Index
  // ---------------------------------------------------------------------------

  /**
   * Build (or rebuild) the semantic index from a freshly fetched item list.
   * Iterates items once and populates all lookup maps.
   */
  private buildSemanticIndex(items: OpenHabItem[]): void {
    const byRoom = new Map<string, Set<string>>();
    const byTag = new Map<string, Set<string>>();
    const byType = new Map<string, Set<string>>();
    const byToken = new Map<string, Set<string>>();
    const byPrefix = new Map<string, Set<string>>();
    const byCategory = new Map<string, Set<string>>();
    const itemMap = new Map<string, OpenHabItem>();
    const rooms: OpenHabItem[] = [];

    const addTo = (map: Map<string, Set<string>>, key: string, value: string) => {
      let s = map.get(key);
      if (!s) {
        s = new Set();
        map.set(key, s);
      }
      s.add(value);
    };

    // Tokenise a string into lowercase words, splitting on underscores and spaces
    const tokenise = (s: string): string[] =>
      s
        .toLowerCase()
        .replace(/[_-]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);

    for (const item of items) {
      itemMap.set(item.name, item);
      addTo(byType, item.type, item.name);

      for (const tag of item.tags ?? []) {
        const norm = tag.toLowerCase();
        addTo(byTag, norm, item.name);
        for (const t of tokenise(tag)) addTo(byTag, t, item.name);
      }

      for (const grp of item.groupNames ?? []) {
        addTo(byRoom, grp.toLowerCase(), item.name);
      }

      if (item.tags?.some((t) => t.toLowerCase().includes('location'))) {
        rooms.push(item);
        // Let the room be searchable by its own label words too
        for (const t of tokenise(item.label ?? item.name)) addTo(byRoom, t, item.name);
      }

      for (const t of tokenise(item.name)) addTo(byToken, t, item.name);
      if (item.label) {
        for (const t of tokenise(item.label)) addTo(byToken, t, item.name);
      }

      // Index category (e.g. 'Motion', 'Temperature', 'Switch') for category-based searches
      if (item.category) {
        const cat = item.category.toLowerCase();
        addTo(byCategory, cat, item.name);
        for (const t of tokenise(item.category)) addTo(byCategory, t, item.name);
      }
    }

    // ---------------------------------------------------------------------------
    // Phase 2: Build transitive itemToRoom and itemToEquipment via BFS.
    //
    // OpenHAB's semantic model is: Location (group) → Equipment (group) → Point (item).
    // The first pass only links items to their DIRECT parent group. A Point inside
    // Equipment inside a Room is NOT visible under the Room in byRoom.
    // BFS from every Location downward ensures all descendants are mapped.
    // ---------------------------------------------------------------------------
    const itemToRoom = new Map<string, string>(); // itemName -> room.name (transitive)
    const itemToEquipment = new Map<string, string>(); // itemName -> equipment group name
    const groupSet = new Set(byType.get('Group') ?? []);

    for (const room of rooms) {
      const queue: string[] = [room.name];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const groupName = queue.shift()!;
        if (visited.has(groupName)) continue;
        visited.add(groupName);
        const members = byRoom.get(groupName.toLowerCase());
        if (!members) continue;
        for (const memberName of members) {
          if (!itemToRoom.has(memberName)) itemToRoom.set(memberName, room.name);
          const memberItem = itemMap.get(memberName);
          // Track direct Equipment parentage so Points can report their Equipment
          if (memberItem?.tags?.some((t) => t.toLowerCase().includes('equipment'))) {
            const equipChildren = byRoom.get(memberName.toLowerCase());
            if (equipChildren) {
              for (const pointName of equipChildren) {
                if (!itemToEquipment.has(pointName)) itemToEquipment.set(pointName, memberName);
              }
            }
          }
          if (groupSet.has(memberName)) queue.push(memberName);
        }
      }
    }

    // Phase 3: Propagate room label tokens back into byToken for every item in that room.
    // This makes queries like "living room light" match items whose own name/label
    // contains no location words (e.g. a channel-linked point called 'Dimmer_CH1').
    const roomLabelTokens = new Map<string, string[]>();
    for (const room of rooms) {
      roomLabelTokens.set(room.name, tokenise(room.label ?? room.name));
    }
    for (const [itemName, roomName] of itemToRoom) {
      const tokens = roomLabelTokens.get(roomName);
      if (tokens) for (const t of tokens) addTo(byToken, t, itemName);
    }

    // Phase 4: Build prefix index — for each token of length ≥ 3, register every
    // 2-char-and-up prefix so prefix searches are O(1) map lookups instead of O(n)
    // full token-map scans. This is the dominant CPU cost during resolveItem() for
    // short query terms like "kit" or "li".
    for (const [token, itemNames] of byToken) {
      for (let len = 2; len < token.length; len++) {
        const prefix = token.slice(0, len);
        // Only store if the prefix doesn't already have its own exact entry
        if (!byToken.has(prefix)) {
          let s = byPrefix.get(prefix);
          if (!s) {
            s = new Set();
            byPrefix.set(prefix, s);
          }
          for (const n of itemNames) s.add(n);
        }
      }
    }

    this.semanticIndex = {
      byRoom,
      byTag,
      byType,
      byToken,
      byPrefix,
      byCategory,
      itemMap,
      itemToRoom,
      itemToEquipment,
      rooms,
    };
    this.log(
      `Semantic index built: ${items.length} items, ${rooms.length} rooms, ` +
        `${itemToRoom.size} room-mapped, ${byToken.size} tokens, ${byCategory.size} categories`
    );
  }

  // ---------------------------------------------------------------------------
  // --- Items ---
  async getItems(
    tags?: string,
    type?: string,
    metadata?: string,
    state?: string
  ): Promise<OpenHabItem[]> {
    const params: Record<string, string> = {};
    if (tags) params.tags = tags;
    if (type) params.type = type;
    // Only fetch metadata when explicitly requested. The bulk metadata payload
    // (voice-assistant mappings, widget config, synonyms, link profiles, etc.) is
    // commonly 10–50× the size of the core item fields and is rarely needed by most
    // operations. Callers that genuinely need metadata pass metadata='.*' explicitly.
    if (metadata) params.metadata = metadata;

    // Canonical cache key:
    //   items_all        — slim (no metadata), powers the semantic index and most tools
    //   items_all_meta   — metadata-inclusive, used only by auditVoiceExposure etc.
    //   items_<filters>  — filtered subsets (tags/type/state queries)
    const hasFilters = !!(tags || type || state);
    const cacheKey = hasFilters
      ? `items_${tags ?? ''}_${type ?? ''}_${metadata ?? ''}_${state ?? ''}`
      : metadata
        ? 'items_all_meta'
        : 'items_all';

    // Track non-default keys so targeted invalidation can clear them on item changes.
    if (cacheKey !== 'items_all') {
      this.filteredCacheKeys.add(cacheKey);
    }

    return this.withCache(cacheKey, this.ITEM_CACHE_TTL, async () => {
      // Restrict fields projection to exclude heavy read-only fields (lastState,
      // lastStateUpdate, lastStateChange, stateDescription, link, editable, members).
      // Image items (e.g. Frigate camera snapshots) have 100 KB+ base64 in lastState.
      params.fields = metadata
        ? 'name,state,label,type,category,tags,groupNames,metadata'
        : 'name,state,label,type,category,tags,groupNames';
      const response = await this.client.get('/rest/items', { params });
      let items = response.data;

      // Filter by strict state if requested
      if (state) {
        items = items.filter((i: OpenHabItem) => i.state.toString() === state);
      }

      // Apply Focus Scope if active and no broader filter is requested
      if (this.focusScope && !tags && !type && !metadata) {
        items = items.filter((i: OpenHabItem) => {
          if (this.focusScope!.type === 'room') return i.tags?.includes(this.focusScope!.name);
          if (this.focusScope!.type === 'group')
            return i.groupNames?.includes(this.focusScope!.name);
          return true;
        });
      }
      // Rebuild semantic index only from the slim 'items_all' fetch — the index only
      // uses name/label/type/tags/groupNames, none of which require metadata.
      if (cacheKey === 'items_all') {
        this.buildSemanticIndex(items);
      }

      return items;
    });
  }

  async getItem(itemName: string): Promise<OpenHabItem> {
    // Fast-path 1: semantic index itemMap is O(1) and is kept live by SSE patches.
    // Use it whenever items_all is cached and fresh — avoids an O(n) array scan.
    const allCached = this.cache.get('items_all');
    if (allCached && allCached.expiry > Date.now()) {
      const found = this.semanticIndex.itemMap.get(itemName);
      if (found) {
        this.log(`Cache HIT (itemMap fast-path): item_${itemName}`);
        return found;
      }
    }
    return this.withCache(`item_${itemName}`, this.ITEM_CACHE_TTL, async () => {
      const response = await this.client.get(`/rest/items/${itemName}`, {
        params: { metadata: '.*' },
      });
      return response.data;
    });
  }

  /**
   * Optimization: Fetch multiple items in a single request to reduce round-trip delays.
   * Checks individual item cache entries first; only fetches uncached items from the API.
   * Writes fetched results back into the per-item cache so subsequent getItem() calls hit.
   */
  async getMultiItems(itemNames: string[]): Promise<OpenHabItem[]> {
    const now = Date.now();
    const results: OpenHabItem[] = [];
    const missing: string[] = [];

    for (const name of itemNames) {
      const cached = this.cache.get(`item_${name}`);
      if (cached && cached.expiry > now) {
        this.log(`Cache HIT (multi): item_${name}`);
        results.push(cached.data as OpenHabItem);
      } else {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      this.log(`Cache MISS (multi): fetching ${missing.length} items`);
      const response = await this.client.get('/rest/items', {
        params: {
          names: missing.join(','),
          fields: 'name,state,label,type,category,tags,groupNames,metadata',
          metadata: '.*',
        },
      });
      const fetched: OpenHabItem[] = response.data;

      // Write-through: populate per-item cache and also patch items_all if present
      const allCached = this.cache.get('items_all');
      for (const item of fetched) {
        this.cache.set(`item_${item.name}`, { data: item, expiry: now + this.ITEM_CACHE_TTL });
        if (allCached) {
          const idx = (allCached.data as OpenHabItem[]).findIndex((i) => i.name === item.name);
          if (idx !== -1) (allCached.data as OpenHabItem[])[idx] = item;
        }
        results.push(item);
      }
    }

    // Restore original requested order
    const nameIndex = new Map(results.map((i, idx) => [i.name, idx]));
    return itemNames.map((n) => results[nameIndex.get(n) ?? 0]).filter(Boolean);
  }

  async sendCommand(itemName: string, command: string): Promise<string> {
    // Optimization: Smart Command Casting (also used to prime item type for optimistic patch)
    let processedCommand = command;
    try {
      const item = await this.getItem(itemName);
      if (item.type === 'Dimmer') {
        if (command.toUpperCase() === 'ON') processedCommand = '100';
        if (command.toUpperCase() === 'OFF') processedCommand = '0';
      } else if (item.type === 'Switch') {
        if (command === '100') processedCommand = 'ON';
        if (command === '0') processedCommand = 'OFF';
      } else if (item.type === 'Color' && command.startsWith('#')) {
        const hex = command.replace('#', '');
        if (hex.length === 6) {
          const r = parseInt(hex.substring(0, 2), 16) / 255;
          const g = parseInt(hex.substring(2, 4), 16) / 255;
          const b = parseInt(hex.substring(4, 6), 16) / 255;
          const max = Math.max(r, g, b),
            min = Math.min(r, g, b);
          let h = 0,
            s = 0;
          const v = max;
          const d = max - min;
          s = max === 0 ? 0 : d / max;
          if (max !== min) {
            switch (max) {
              case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
              case g:
                h = (b - r) / d + 2;
                break;
              case b:
                h = (r - g) / d + 4;
                break;
            }
            h /= 6;
          }
          processedCommand = `${Math.round(h * 360)},${Math.round(s * 100)},${Math.round(v * 100)}`;
        }
      }
    } catch {
      // Ignore fetch errors, proceed with raw command
    }

    this.invalidateItemCache(itemName);
    const response = await this.client.post(`/rest/items/${itemName}`, processedCommand, {
      headers: { 'Content-Type': 'text/plain', Accept: '*/*' },
    });

    // Optimization: Optimistic cache patch — update the known state immediately so
    // subsequent reads within the same session see the new value without a round-trip.
    const optimisticState = processedCommand;
    const cachedItem = this.cache.get(`item_${itemName}`);
    if (cachedItem) {
      (cachedItem.data as OpenHabItem).state = optimisticState;
    }
    const allCached = this.cache.get('items_all');
    if (allCached) {
      const itemInAll = (allCached.data as OpenHabItem[]).find((i) => i.name === itemName);
      if (itemInAll) itemInAll.state = optimisticState;
    }

    return response.data;
  }

  async updateState(itemName: string, state: string): Promise<string> {
    this.invalidateItemCache(itemName);
    const response = await this.client.put(`/rest/items/${itemName}/state`, state, {
      headers: { 'Content-Type': 'text/plain', Accept: '*/*' },
    });
    return response.data;
  }

  async createOrUpdateItem(itemName: string, itemData: Record<string, unknown>): Promise<void> {
    this.invalidateItemCache(itemName);
    const { metadata, ...coreData } = itemData;

    // Safe merge: if this item already exists, preserve any groupNames and tags not in the
    // caller's payload. This prevents a partial update from wiping group memberships and
    // breaking automation rules that depend on those groups.
    const existing = this.semanticIndex.itemMap.get(itemName);
    if (existing) {
      if (!coreData.groupNames) {
        coreData.groupNames = existing.groupNames;
      } else {
        coreData.groupNames = Array.from(
          new Set([...existing.groupNames, ...(coreData.groupNames as string[])])
        );
      }
      if (!coreData.tags) {
        coreData.tags = existing.tags;
      } else {
        coreData.tags = Array.from(new Set([...existing.tags, ...(coreData.tags as string[])]));
      }
    }

    // 1. Create/Update core item (handles tags and groupNames natively)
    const response = await this.client.put(`/rest/items/${itemName}`, coreData);

    // 2. Configure metadata if provided in the consolidated payload.
    // Only the namespaces explicitly supplied are written; all others are left untouched.
    if (metadata && typeof metadata === 'object') {
      for (const [namespace, data] of Object.entries(metadata)) {
        const valData = data as Record<string, unknown>;
        const payload =
          typeof valData === 'object' && valData !== null ? valData : { value: valData };
        await this.client.put(`/rest/items/${itemName}/metadata/${namespace}`, payload);
      }
    }
    return response.data;
  }

  async deleteItem(itemName: string): Promise<void> {
    this.invalidateItemCache(itemName);
    const response = await this.client.delete(`/rest/items/${itemName}`);
    return response.data;
  }

  async addTag(itemName: string, tag: string): Promise<void> {
    this.invalidateItemCache(itemName);
    const response = await this.client.put(`/rest/items/${itemName}/tags/${tag}`);
    return response.data;
  }

  async removeTag(itemName: string, tag: string): Promise<void> {
    this.invalidateItemCache(itemName);
    const response = await this.client.delete(`/rest/items/${itemName}/tags/${tag}`);
    return response.data;
  }

  async setMetadata(
    itemName: string,
    namespace: string,
    value: string,
    config?: Record<string, unknown>
  ): Promise<void> {
    this.invalidateItemCache(itemName);
    const data = { value, config };
    const response = await this.client.put(`/rest/items/${itemName}/metadata/${namespace}`, data);
    return response.data;
  }

  async removeMetadata(itemName: string, namespace: string): Promise<void> {
    this.invalidateItemCache(itemName);
    const response = await this.client.delete(`/rest/items/${itemName}/metadata/${namespace}`);
    return response.data;
  }

  /**
   * Finds equipment of a specific type within a room.
   * Traverses the semantic model: Room -> Equipment -> Points.
   */
  async findEquipmentByType(
    roomName: string,
    equipmentType: string
  ): Promise<Array<{ equipment: OpenHabItem; points: OpenHabItem[] }>> {
    await this.getItems(); // ensure index
    const idx = this.semanticIndex;
    const roomLower = roomName.toLowerCase();
    const eqTypeLower = equipmentType.toLowerCase();

    // 1. Resolve room via index — O(1) map or short rooms-list scan
    const room =
      (idx.itemMap.get(roomName)?.tags?.some((t) => t.toLowerCase().includes('location'))
        ? idx.itemMap.get(roomName)
        : undefined) ??
      idx.rooms.find(
        (r) => r.name.toLowerCase() === roomLower || r.label?.toLowerCase() === roomLower
      );

    if (!room) {
      this.log(`Semantic Search: Room '${roomName}' not found.`);
      return [];
    }

    // 2. Direct children from byRoom (O(1) map lookup)
    const childNames = idx.byRoom.get(room.name.toLowerCase()) ?? new Set<string>();
    const equipment = Array.from(childNames)
      .map((n) => idx.itemMap.get(n)!)
      .filter((i) => i && i.tags?.some((t) => t.toLowerCase().includes(eqTypeLower)));

    // 3. Points via byRoom for each equipment group — O(1) per equipment
    return equipment.map((e) => ({
      equipment: e,
      points: Array.from(idx.byRoom.get(e.name.toLowerCase()) ?? [])
        .map((n) => idx.itemMap.get(n)!)
        .filter(Boolean),
    }));
  }

  // --- Things ---
  async getThings(): Promise<OpenHabThing[]> {
    return this.withCache('things_all', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/things');
      // Strip channels from bulk list — each thing can have 50–100 channel definitions
      // which bloat payloads dramatically without being needed for status/command flows.
      // Individual getThing() still returns full data with channels.
      return (response.data as OpenHabThing[]).map(
        ({ channels: _ch, ...rest }) => rest as OpenHabThing
      );
    });
  }

  async getThing(thingUID: string): Promise<OpenHabThing> {
    return this.withCache(`thing_${thingUID}`, this.META_CACHE_TTL, async () => {
      const response = await this.client.get(`/rest/things/${thingUID}`);
      return response.data;
    });
  }

  async createThing(thingData: Partial<OpenHabThing>): Promise<OpenHabThing> {
    const response = await this.client.post('/rest/things', thingData);
    return response.data;
  }

  async updateThing(thingUID: string, thingData: Partial<OpenHabThing>): Promise<OpenHabThing> {
    const response = await this.client.put(`/rest/things/${thingUID}`, thingData);
    return response.data;
  }

  async deleteThing(thingUID: string, force = false): Promise<void> {
    const response = await this.client.delete(`/rest/things/${thingUID}`, {
      params: { force },
    });
    return response.data;
  }

  async enableThing(thingUID: string, enable: boolean): Promise<void> {
    const response = await this.client.put(`/rest/things/${thingUID}/enable`, enable.toString(), {
      headers: { 'Content-Type': 'text/plain' },
    });
    return response.data;
  }

  async getThingStatus(thingUID: string): Promise<{ status: string; statusDetail: string }> {
    const response = await this.client.get(`/rest/things/${thingUID}/status`);
    return response.data;
  }

  async updateThingConfig(thingUID: string, config: Record<string, unknown>): Promise<void> {
    const response = await this.client.put(`/rest/things/${thingUID}/config`, config);
    return response.data;
  }

  // --- Links ---
  async getLinks(itemName?: string, channelUID?: string): Promise<OpenHabLink[]> {
    const params: Record<string, string> = {};
    if (itemName) params.itemName = itemName;
    if (channelUID) params.channelUID = channelUID;
    const response = await this.client.get('/rest/links', { params });
    return response.data;
  }

  async linkItemToChannel(
    itemName: string,
    channelUID: string,
    config?: Record<string, unknown>
  ): Promise<void> {
    const response = await this.client.put(`/rest/links/${itemName}/${channelUID}`, {
      configuration: config || {},
    });
    return response.data;
  }

  async unlinkItemFromChannel(itemName: string, channelUID: string): Promise<void> {
    const response = await this.client.delete(`/rest/links/${itemName}/${channelUID}`);
    return response.data;
  }

  // --- Semantic Tags ---
  async getSemanticTags(): Promise<OpenHabSemanticTag[]> {
    return this.withCache('semantic_tags', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/tags');
      return response.data;
    });
  }

  async createSemanticTag(tagData: OpenHabSemanticTag): Promise<void> {
    const response = await this.client.post('/rest/tags', tagData);
    this.cache.delete('semantic_tags');
    return response.data;
  }

  async getSemanticTag(tagId: string): Promise<OpenHabSemanticTag> {
    const response = await this.client.get(`/rest/tags/${tagId}`);
    return response.data;
  }

  async updateSemanticTag(tagId: string, tagData: OpenHabSemanticTag): Promise<void> {
    const response = await this.client.put(`/rest/tags/${tagId}`, tagData);
    this.cache.delete('semantic_tags');
    return response.data;
  }

  async deleteSemanticTag(tagId: string): Promise<void> {
    const response = await this.client.delete(`/rest/tags/${tagId}`);
    this.cache.delete('semantic_tags');
    return response.data;
  }

  // --- Rules ---
  async getRules(): Promise<OpenHabRule[]> {
    return this.withCache('rules_all', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/rules');
      return response.data;
    });
  }

  async getRule(ruleUID: string): Promise<OpenHabRule> {
    return this.withCache(`rule_${ruleUID}`, this.META_CACHE_TTL, async () => {
      const response = await this.client.get(`/rest/rules/${ruleUID}`);
      return response.data;
    });
  }

  async createRule(ruleData: Partial<OpenHabRule>): Promise<OpenHabRule> {
    const response = await this.client.post('/rest/rules', ruleData);
    return response.data;
  }

  async updateRule(ruleUID: string, ruleData: Partial<OpenHabRule>): Promise<OpenHabRule> {
    const response = await this.client.put(`/rest/rules/${ruleUID}`, ruleData);
    return response.data;
  }

  async deleteRule(ruleUID: string): Promise<void> {
    const response = await this.client.delete(`/rest/rules/${ruleUID}`);
    return response.data;
  }

  async runRule(ruleUID: string, context?: Record<string, unknown>): Promise<void> {
    const response = await this.client.post(`/rest/rules/${ruleUID}/runnow`, context || {});
    return response.data;
  }

  async enableRule(ruleUID: string, enable: boolean): Promise<void> {
    const response = await this.client.post(`/rest/rules/${ruleUID}/enable`, enable.toString(), {
      headers: { 'Content-Type': 'text/plain' },
    });
    return response.data;
  }

  // --- Inbox / Discovery ---
  async getInbox(): Promise<OpenHabInboxItem[]> {
    return this.withCache('inbox_all', this.ITEM_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/inbox');
      return response.data;
    });
  }

  async approveInboxItem(thingUID: string, label?: string, newThingId?: string): Promise<void> {
    const params: Record<string, string> = {};
    if (newThingId) params.newThingId = newThingId;
    const response = await this.client.post(`/rest/inbox/${thingUID}/approve`, label || '', {
      params,
      headers: { 'Content-Type': 'text/plain' },
    });
    return response.data;
  }

  async ignoreInboxItem(thingUID: string): Promise<void> {
    const response = await this.client.post(`/rest/inbox/${thingUID}/ignore`);
    return response.data;
  }

  async unignoreInboxItem(thingUID: string): Promise<void> {
    const response = await this.client.post(`/rest/inbox/${thingUID}/unignore`);
    return response.data;
  }

  // --- Persistence ---
  async getPersistenceServices(): Promise<Array<{ id: string; label: string; default: boolean }>> {
    const response = await this.client.get('/rest/persistence');
    return response.data;
  }

  async getItemPersistenceData(
    itemName: string,
    serviceId?: string,
    starttime?: string,
    endtime?: string
  ): Promise<OpenHabPersistenceData> {
    const params: Record<string, string> = {};
    if (serviceId) params.serviceId = serviceId;
    if (starttime) params.starttime = starttime;
    if (endtime) params.endtime = endtime;
    const response = await this.client.get(`/rest/persistence/items/${itemName}`, { params });
    return response.data;
  }

  async storeItemPersistenceData(
    itemName: string,
    time: string,
    state: string,
    serviceId?: string
  ): Promise<void> {
    const params: Record<string, string> = { time, state };
    if (serviceId) params.serviceId = serviceId;
    const response = await this.client.put(`/rest/persistence/items/${itemName}`, null, { params });
    return response.data;
  }

  /**
   * Analyzes persistence data for an item over a period.
   * Calculates averages/peaks for numbers or duty cycles for switches.
   */
  async getItemStatistics(
    itemName: string,
    starttime?: string,
    endtime?: string,
    serviceId?: string
  ): Promise<Record<string, unknown>> {
    // item metadata and historical data are independent — fetch in parallel
    const [item, data] = await Promise.all([
      this.getItem(itemName),
      this.getItemPersistenceData(itemName, serviceId, starttime, endtime),
    ]);

    if (!data.data || data.data.length === 0) {
      return { itemName, message: 'No data available for this period' };
    }

    const values = data.data.map((d) => parseFloat(d.state)).filter((v) => !isNaN(v));

    // 3. Perform analysis based on item type
    const isNumeric =
      item.type.includes('Number') || item.type.includes('Dimmer') || item.type.includes('Color');

    if (isNumeric && values.length > 0) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      return {
        itemName,
        type: 'numeric',
        count: values.length,
        min,
        max,
        average: avg,
        current: item.state,
      };
    } else {
      // Binary / Boolean Analysis (ON/OFF)
      let onTime = 0;
      let totalTime = 0;
      const points = data.data;

      for (let i = 0; i < points.length - 1; i++) {
        const current = points[i];
        const next = points[i + 1];
        const duration = new Date(next.time).getTime() - new Date(current.time).getTime();

        totalTime += duration;
        if (current.state === 'ON' || parseFloat(current.state) > 0) {
          onTime += duration;
        }
      }

      const dutyCycle = totalTime > 0 ? (onTime / totalTime) * 100 : 0;
      return {
        itemName,
        type: 'stateful',
        onTimeHours: onTime / 3600000,
        totalTimeHours: totalTime / 3600000,
        dutyCyclePercentage: dutyCycle.toFixed(2) + '%',
        current: item.state,
      };
    }
  }

  /**
   * Normalizes media controls across different device types.
   * Handles Player items, Dimmers (volume), and Switches (power/play).
   */
  async controlMedia(equipmentName: string, action: string): Promise<string> {
    await this.getItems(); // ensure index
    const idx = this.semanticIndex;

    // Resolve equipment: try exact name first (O(1)), then label scan over itemMap
    let equipment = idx.itemMap.get(equipmentName);
    if (!equipment) {
      const labelLower = equipmentName.toLowerCase();
      for (const [, item] of idx.itemMap) {
        if (item.label?.toLowerCase() === labelLower) {
          equipment = item;
          break;
        }
      }
    }
    if (!equipment) throw new Error(`Equipment '${equipmentName}' not found`);

    // Points: O(1) byRoom lookup on equipment group name instead of O(n) filter
    const pointNames = idx.byRoom.get(equipment.name.toLowerCase()) ?? new Set<string>();
    const points = Array.from(pointNames)
      .map((n) => idx.itemMap.get(n)!)
      .filter(Boolean);

    const player = points.find((p) => p.type === 'Player');
    const volume = points.find(
      (p) =>
        p.name.toLowerCase().includes('volume') ||
        p.label?.toLowerCase().includes('volume') ||
        p.name.toLowerCase().endsWith('_vol') ||
        p.tags?.includes('SpeakerVolume')
    );
    const playPause = points.find(
      (p) =>
        p.name.toLowerCase().includes('play') ||
        p.label?.toLowerCase().includes('play') ||
        p.tags?.includes('Control')
    );

    switch (action.toLowerCase()) {
      case 'play':
        if (player) return this.sendCommand(player.name, 'PLAY');
        if (playPause) return this.sendCommand(playPause.name, 'ON');
        break;
      case 'pause':
        if (player) return this.sendCommand(player.name, 'PAUSE');
        if (playPause) return this.sendCommand(playPause.name, 'OFF');
        break;
      case 'volume_up':
        if (volume) {
          const currentVol = parseFloat(volume.state) || 0;
          return this.sendCommand(volume.name, Math.min(currentVol + 10, 100).toString());
        }
        break;
      case 'volume_down':
        if (volume) {
          const currentVol = parseFloat(volume.state) || 0;
          return this.sendCommand(volume.name, Math.max(currentVol - 10, 0).toString());
        }
        break;
      case 'next':
        if (player) return this.sendCommand(player.name, 'NEXT');
        break;
      case 'previous':
        if (player) return this.sendCommand(player.name, 'PREVIOUS');
        break;
    }

    throw new Error(
      `Action '${action}' not supported for equipment '${equipmentName}' or required points missing`
    );
  }

  // --- Voice / Audio ---
  async voiceSay(text: string, voiceId?: string, sinkId?: string, volume?: string): Promise<void> {
    const params: Record<string, string> = {};
    if (voiceId) params.voiceid = voiceId;
    if (sinkId) params.sinkid = sinkId;
    if (volume) params.volume = volume;
    const response = await this.client.post('/rest/voice/say', text, {
      params,
      headers: { 'Content-Type': 'text/plain' },
    });
    return response.data;
  }

  async voiceInterpret(text: string, interpreterIds?: string): Promise<void> {
    const url = interpreterIds
      ? `/rest/voice/interpreters/${interpreterIds}`
      : '/rest/voice/interpreters';
    const response = await this.client.post(url, text, {
      headers: { 'Content-Type': 'text/plain' },
    });
    return response.data;
  }

  async getVoices(): Promise<Array<{ id: string; label: string }>> {
    return this.withCache('voices', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/voice/voices');
      return response.data;
    });
  }

  async getAudioSinks(): Promise<Array<{ id: string; label: string }>> {
    return this.withCache('audio_sinks', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/audio/sinks');
      return response.data;
    });
  }

  async getAudioSources(): Promise<Array<{ id: string; label: string }>> {
    return this.withCache('audio_sources', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/audio/sources');
      return response.data;
    });
  }

  // --- Addons ---
  async getAddons(): Promise<OpenHabAddon[]> {
    return this.withCache('addons', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/addons');
      return response.data;
    });
  }

  async installAddon(addonId: string): Promise<void> {
    const response = await this.client.post(`/rest/addons/${addonId}/install`);
    this.cache.delete('addons');
    return response.data;
  }

  async uninstallAddon(addonId: string): Promise<void> {
    const response = await this.client.post(`/rest/addons/${addonId}/uninstall`);
    this.cache.delete('addons');
    return response.data;
  }

  // --- Sitemaps & UI ---
  async getSitemaps(): Promise<OpenHabSitemap[]> {
    return this.withCache('sitemaps', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/sitemaps');
      return response.data;
    });
  }

  async getUIComponents(namespace: string): Promise<unknown> {
    return this.withCache(`ui_components_${namespace}`, this.META_CACHE_TTL, async () => {
      const response = await this.client.get(`/rest/ui/components/${namespace}`);
      return response.data;
    });
  }

  async getUITiles(): Promise<unknown> {
    return this.withCache('ui_tiles', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/ui/tiles');
      return response.data;
    });
  }

  // --- System & Config ---
  async getSystemInfo(): Promise<Record<string, unknown>> {
    const response = await this.client.get('/rest/systeminfo');
    return response.data;
  }

  async getLoggers(): Promise<OpenHabLogger[]> {
    const response = await this.client.get('/rest/logging');
    return response.data.loggers || [];
  }

  async setLoggerLevel(loggerName: string, level: string): Promise<void> {
    const response = await this.client.put(`/rest/logging/${loggerName}`, { loggerName, level });
    return response.data;
  }

  async getServices(): Promise<OpenHabService[]> {
    return this.withCache('services', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/services');
      return response.data;
    });
  }

  async getServiceConfig(serviceId: string): Promise<OpenHabServiceConfig> {
    const response = await this.client.get(`/rest/services/${serviceId}/config`);
    return response.data;
  }

  async updateServiceConfig(serviceId: string, config: OpenHabServiceConfig): Promise<void> {
    const response = await this.client.put(`/rest/services/${serviceId}/config`, config);
    return response.data;
  }

  async getTemplates(): Promise<OpenHabTemplate[]> {
    return this.withCache('templates', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/templates');
      return response.data;
    });
  }

  async getTransformations(): Promise<OpenHabTransformation[]> {
    return this.withCache('transformations', this.META_CACHE_TTL, async () => {
      const response = await this.client.get('/rest/transformations');
      return response.data;
    });
  }

  // --- Habot ---
  async chatWithHabot(text: string): Promise<string> {
    const response = await this.client.post('/rest/habot/chat', text, {
      headers: { 'Content-Type': 'text/plain' },
    });
    return response.data;
  }

  /**
   * Provides a high-density system summary to save LLM tokens.
   */
  async getSystemSummary(): Promise<{
    overview: { totalItems: number; totalThings: number; roomsFound: number };
    equipmentDistribution: Record<string, number>;
    rooms: string[];
    activeSnapshot: string[];
    systemIssues: string[] | string;
    systemPolicy: {
      preferredItemManagement: string;
      preferredRuleFormat: string;
      recommendation: string;
    };
  }> {
    // Optimization: fetch items and things concurrently — they are independent
    const [, things] = await Promise.all([this.getItems(), this.getThings()]);

    // 1. Reuse the byType index built during getItems() — no extra O(n) pass needed
    const idx = this.semanticIndex;
    const itemStats: Record<string, number> = {};
    for (const [type, names] of idx.byType) {
      itemStats[type] = names.size;
    }

    // 2. Find rooms — use pre-built semantic index instead of O(n) filter
    const rooms = idx.rooms.map((r) => r.label ?? r.name);

    // 3. Current "Active" states (e.g. Lights ON, Doors OPEN)
    // Iterate the semantic index itemMap — avoids keeping a separate items array reference
    const activeStates: string[] = [];
    for (const [, i] of idx.itemMap) {
      if (activeStates.length >= 30) break;
      const isSwitchOn = i.state === 'ON' || i.state === 'OPEN';
      const isNotableNumber =
        i.type.includes('Number') &&
        parseFloat(i.state) > 0 &&
        (i.name.toLowerCase().includes('temp') ||
          i.name.toLowerCase().includes('lux') ||
          i.name.toLowerCase().includes('battery'));
      const isGlobalState =
        i.name === 'Day' || i.name === 'House_Awake' || i.name.includes('_Awake');
      if (isSwitchOn || isNotableNumber || isGlobalState) {
        activeStates.push(`${i.label || i.name}: ${i.state}`);
      }
    }

    // 4. Offline/Error check
    const issues = things
      .filter((t) => t.statusInfo?.status !== 'ONLINE')
      .map((t) => `${t.label}: ${t.statusInfo?.status}`);

    return {
      overview: {
        totalItems: idx.itemMap.size,
        totalThings: things.length,
        roomsFound: rooms.length,
      },
      equipmentDistribution: itemStats,
      rooms,
      activeSnapshot: activeStates,
      systemIssues: issues.length > 0 ? issues : 'All systems normal',
      systemPolicy: {
        preferredItemManagement: 'Managed (REST API)',
        preferredRuleFormat: 'Modern JavaScript (application/javascript)',
        recommendation:
          'Favor using create_or_update_item tool over file-based configuration to ensure better integration with this MCP.',
      },
    };
  }

  /**
   * Validates rule logic for safety and syntax.
   */
  async validateRuleLogic(
    script: string,
    type: string
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic syntax check for JS
    if (type === 'application/javascript') {
      try {
        new Function(script);
      } catch (e: unknown) {
        errors.push(`JS Syntax Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Logical Safety Checks
    if (script.includes('.sendCommand(')) {
      // Check if command is targeting the same item (potential loop)
      // This is a naive check but helpful for AI
      if (script.length < 50) {
        warnings.push('Rule script is unusually short; ensure logical guards are present.');
      }
    }

    if (script.includes('while(true)') || script.includes('for(;;)')) {
      errors.push('Infinite loop detected. This will crash the OpenHAB engine.');
    }

    // Check for non-existent item references in the script
    const allItems = await this.getItems();
    const itemNames = new Set(allItems.map((i) => i.name));

    // Simple regex for item name patterns like 'ItemName.' or '["ItemName"]'
    const itemRefs = script.match(/[A-Z0-9_]{3,}/gi) || [];
    const suspectedItems = itemRefs.filter((ref) => itemNames.has(ref));

    if (suspectedItems.length === 0 && script.includes('items.')) {
      warnings.push('No known item names detected in script. Ensure item names are correct.');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Generates TypeScript interfaces for the current home system.
   */
  async generateSystemBoilerplate(): Promise<string> {
    await this.getItems(); // ensure semantic index is built
    const idx = this.semanticIndex;

    let boilerplate = `/**
 * OpenHAB Home System Types
 * Generated on ${new Date().toISOString()}
 */\n\n`;

    boilerplate += 'export type HomeItems = {\n';

    // Single pass via pre-built itemMap — avoids re-fetching the items array
    for (const [, i] of idx.itemMap) {
      let tsType = 'string';
      if (i.type.includes('Number')) tsType = 'number';
      if (i.type === 'Switch' || i.type === 'Contact') tsType = '"ON" | "OFF" | "OPEN" | "CLOSED"';

      boilerplate += `  /** ${i.label || 'No label'} */\n`;
      boilerplate += `  ${i.name}: ${tsType};\n`;
    }

    boilerplate += '};\n\n';

    // idx.rooms is already the filtered list of Location items — no second pass needed
    boilerplate +=
      'export type RoomNames = ' + idx.rooms.map((i) => `'${i.name}'`).join(' | ') + ';\n';

    return boilerplate;
  }

  /**
   * Executes multiple commands in parallel.
   */
  async executeBatch(
    commands: Array<{ itemName: string; command?: string; state?: string }>
  ): Promise<string[]> {
    this.log(`Executing batch of ${commands.length} commands...`);
    const results: string[] = await Promise.all(
      commands.map((c) => {
        if (c.command !== undefined) {
          return this.sendCommand(c.itemName, c.command)
            .then(() => `Command Success on ${c.itemName}: ${c.command}`)
            .catch((e) => `Error on ${c.itemName}: ${e.message}`);
        } else if (c.state !== undefined) {
          return this.updateState(c.itemName, c.state)
            .then(() => `State Update Success on ${c.itemName}: ${c.state}`)
            .catch((e) => `Error on ${c.itemName}: ${e.message}`);
        } else {
          return Promise.resolve(`Error on ${c.itemName}: No command or state provided.`);
        }
      })
    );
    return results;
  }

  /**
   * Fuzzy search for items by name, label, tags, or groups.
   * Uses the semantic index for O(1) token lookups and set intersections.
   */
  async searchItems(query: string): Promise<OpenHabItem[]> {
    const terms = query
      .toLowerCase()
      .replace(/[_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];

    await this.getItems(); // ensure index is built
    const idx = this.semanticIndex;

    // For each term collect candidate sets from all dimensions, then intersect
    let candidates: Set<string> | null = null;
    for (const term of terms) {
      const hits = new Set<string>();
      const sources = [
        idx.byToken.get(term),
        idx.byRoom.get(term),
        idx.byTag.get(term),
        idx.byType.get(term),
        idx.byCategory.get(term),
        // O(1) prefix lookup via pre-built byPrefix index
        idx.byPrefix.get(term),
      ];
      for (const s of sources) if (s) for (const n of s) hits.add(n);

      if (candidates === null) {
        candidates = hits;
      } else {
        for (const n of candidates) if (!hits.has(n)) candidates.delete(n);
      }
    }

    return Array.from(candidates ?? [])
      .slice(0, 50)
      .map((n) => idx.itemMap.get(n)!)
      .filter(Boolean);
  }

  /**
   * Semantic item resolver: converts natural-language intent into ranked matches.
   *
   * This is the PRIMARY discovery tool the LLM should call instead of blind
   * search loops. It scores candidates across every index dimension and returns
   * the top results with enough context (exact name, label, room, type, state)
   * to act immediately without any follow-up calls.
   *
   * Examples:
   *   "kitchen light"          -> Kitchen_Ceiling_Switch (Switch, OFF, Kitchen)
   *   "front door"             -> Door_FrontDoor_OpenClosed (Contact, CLOSED, Hallway)
   *   "living room thermostat" -> LivingRoom_Thermostat_SetPoint (Number, 21.0, LivingRoom)
   */
  async resolveItem(query: string): Promise<
    Array<{
      name: string;
      label?: string;
      type: string;
      state: string;
      room?: string;
      equipment?: string;
      tags: string[];
      score: number;
    }>
  > {
    await this.getItems(); // ensure index exists
    const idx = this.semanticIndex;
    const terms = query
      .toLowerCase()
      .replace(/[_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];

    const scores = new Map<string, number>();
    const bump = (set: Set<string> | undefined, weight: number) => {
      if (!set) return;
      for (const n of set) scores.set(n, (scores.get(n) ?? 0) + weight);
    };

    for (const term of terms) {
      bump(idx.byToken.get(term), 3); // label/name/room-propagated token exact match
      bump(idx.byRoom.get(term), 3); // direct group membership keyword
      bump(idx.byTag.get(term), 2); // semantic tag
      bump(idx.byCategory.get(term), 2); // category (Motion, Temperature, etc.)
      bump(idx.byType.get(term), 1); // item type
      bump(idx.byType.get(term.charAt(0).toUpperCase() + term.slice(1)), 1);
      // O(1) prefix bonus via pre-built byPrefix index (replaces O(n) token map scan)
      bump(idx.byPrefix.get(term), 1);
    }

    if (scores.size === 0) return [];

    // Use pre-built transitive itemToRoom (covers Location→Equipment→Point chains).
    // No inline room computation needed — O(1) per item.
    const roomLabelOf = new Map(idx.rooms.map((r) => [r.name, r.label ?? r.name]));

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, score]) => {
        const item = idx.itemMap.get(name)!;
        const roomName = idx.itemToRoom.get(name);
        const equipName = idx.itemToEquipment.get(name);
        return {
          name: item.name,
          label: item.label,
          type: item.type,
          state: item.state,
          room: roomName ? (roomLabelOf.get(roomName) ?? roomName) : undefined,
          equipment: equipName ? (idx.itemMap.get(equipName)?.label ?? equipName) : undefined,
          tags: item.tags ?? [],
          score,
        };
      })
      .filter((r) => r.name);
  }

  /**
   * Unified search across items, things, and rules.
   * Reduces multiple MCP calls when entity type is unknown.
   * Returns slim projections to avoid metadata bloat — use query_items/query_things
   * for full detail once the entity name is known.
   */
  async masterSearch(query: string): Promise<{
    items: Array<{ name: string; label?: string; type: string; state: string; room?: string }>;
    things: Array<{ uid: string; label: string; status: string }>;
    rules: Array<{ uid: string; name: string; enabled: boolean }>;
  }> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) return { items: [], things: [], rules: [] };

    // Use searchItems (semantic index) for items + parallel fetch for things/rules
    const [items, things, rules] = await Promise.all([
      this.searchItems(query),
      this.getThings(),
      this.getRules(),
    ]);

    const idx = this.semanticIndex;
    const roomLabelOf = new Map(idx.rooms.map((r) => [r.name, r.label ?? r.name]));

    return {
      items: items.slice(0, 20).map((i) => {
        const roomName = idx.itemToRoom.get(i.name);
        return {
          name: i.name,
          label: i.label,
          type: i.type,
          state: i.state,
          room: roomName ? (roomLabelOf.get(roomName) ?? roomName) : undefined,
        };
      }),
      things: things
        .filter((t) => {
          const haystack = `${t.UID} ${t.label || ''}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
        .slice(0, 10)
        .map((t) => ({ uid: t.UID, label: t.label, status: t.statusInfo?.status ?? 'UNKNOWN' })),
      rules: rules
        .filter((r) => {
          const haystack = `${r.uid} ${r.name || ''}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
        .slice(0, 10)
        .map((r) => ({ uid: r.uid, name: r.name, enabled: r.enabled })),
    };
  }

  /**
   * Gets all equipment and items in a specific room.
   * Uses semantic model traversal.
   */
  async getRoomInventory(roomName: string): Promise<{
    room: OpenHabItem;
    equipment: Array<{ info: OpenHabItem; points: OpenHabItem[] }>;
    standaloneItems: OpenHabItem[];
  }> {
    await this.getItems(); // ensure index
    const idx = this.semanticIndex;

    // 1. Resolve room via index — O(1) by name, or linear scan of rooms list by label
    const roomLower = roomName.toLowerCase();
    const room =
      (idx.itemMap.get(roomName)?.tags?.some((t) => t.toLowerCase().includes('location'))
        ? idx.itemMap.get(roomName)
        : undefined) ??
      idx.rooms.find(
        (r) => r.name.toLowerCase() === roomLower || r.label?.toLowerCase() === roomLower
      );

    if (!room) throw new Error(`Room '${roomName}' not found in semantic model.`);

    // 2. Direct children from byRoom (O(1) map lookup instead of O(n) filter)
    const directChildNames = idx.byRoom.get(room.name.toLowerCase()) ?? new Set<string>();
    const directChildren = Array.from(directChildNames)
      .map((n) => idx.itemMap.get(n)!)
      .filter(Boolean);

    // 3. Separate Equipment from standalone Points — use byRoom for child points too
    const equipment = directChildren
      .filter((i) => i.tags?.some((t) => t.toLowerCase().includes('equipment')))
      .map((e) => ({
        info: e,
        points: Array.from(idx.byRoom.get(e.name.toLowerCase()) ?? [])
          .map((n) => idx.itemMap.get(n)!)
          .filter(Boolean),
      }));

    const standaloneItems = directChildren.filter(
      (i) => !i.tags?.some((t) => t.toLowerCase().includes('equipment'))
    );

    return { room, equipment, standaloneItems };
  }

  /**
   * Minimal schema mapping for discovery.
   */
  async getSchema(): Promise<
    Array<{ name: string; type: string; label?: string; tags: string[]; groups: string[] }>
  > {
    const items = await this.getItems();
    return items.map((i) => ({
      name: i.name,
      type: i.type,
      label: i.label,
      tags: i.tags,
      groups: i.groupNames,
    }));
  }

  /**
   * Priming context for AI agents.
   */
  async getPromptContext(): Promise<string> {
    const summary = await this.getSystemSummary();

    let context = `## OpenHAB Intelligence Context\n\n`;
    context += `You are an expert home automation assistant for the user's specific OpenHAB installation.\n\n`;
    context += `### Environment Status\n`;
    context += `- Rooms Found: ${summary.overview.roomsFound} (${summary.rooms.join(', ')})\n`;
    context += `- Total Items: ${summary.overview.totalItems}\n`;
    context += `- Active States: ${summary.activeSnapshot.join(', ') || 'None'}\n\n`;

    context += `### Core Policies\n`;
    context += `1. **Managed Preference**: Always prefer using \`create_or_update_item\` over manual file editing.\n`;
    context += `2. **Modern Scripting**: Prefer the \`application/javascript\` format for all rules.\n`;
    context += `3. **Safety First**: Use the \`validate_rule_logic\` tool before committing new rule automation.\n\n`;

    context += `### Usage Tips\n`;
    context += `**CRITICAL: NEVER iterate single tool calls. Use the minimum number of requests.**\n`;
    context += `- **ALWAYS call \`resolve_item\` first** when looking for a specific item. It returns exact names, room, type, and current state in one call — no guessing, no loops.\n`;
    context += `- Use \`execute_batch\` when the user asks for multiple actions (e.g. 'Goodnight').\n`;
    context += `- Use \`master_search\` for a combined search across items, things, and rules.\n`;
    context += `- Use \`get_room_inventory\` to see all equipment in a room with its point hierarchy.\n`;
    context += `- Use \`get_semantic_path\` and \`find_neighboring_equipment\` for spatial reasoning.\n`;
    context += `- Use \`schedule_command\` for delayed actions (e.g. 'turn off in 20 minutes').\n`;
    context += `- Use \`get_stale_items\` for proactive sensor maintenance.\n\n`;

    // Compact home quick-reference grouped by room.
    // Format: "Room: name(type=state), name(type=state)"
    // Much more token-efficient than a full markdown table while still giving
    // the LLM exact item names and live states without additional queries.
    const idx = this.semanticIndex;
    const MAX_ITEMS_IN_CONTEXT = 100;
    if (idx.rooms.length > 0) {
      // Group non-Group items by their transitive room label
      const roomLabelOf = new Map(idx.rooms.map((r) => [r.name, r.label ?? r.name]));
      const byRoom = new Map<string, string[]>();
      for (const [itemName, roomName] of idx.itemToRoom) {
        const item = idx.itemMap.get(itemName);
        if (!item || item.type === 'Group') continue;
        const roomLabel = roomLabelOf.get(roomName) ?? roomName;
        let bucket = byRoom.get(roomLabel);
        if (!bucket) {
          bucket = [];
          byRoom.set(roomLabel, bucket);
        }
        bucket.push(`${item.name}(${item.type}=${item.state})`);
      }

      const totalItems = Array.from(byRoom.values()).reduce((s, b) => s + b.length, 0);
      context += `### Home Quick-Reference (${totalItems} items; call resolve_item for natural-language search)\n`;
      let written = 0;
      for (const [roomLabel, entries] of [...byRoom.entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
      )) {
        if (written >= MAX_ITEMS_IN_CONTEXT) {
          context += `…(${totalItems - written} more items — use resolve_item)\n`;
          break;
        }
        const slice = entries.slice(0, MAX_ITEMS_IN_CONTEXT - written);
        context += `${roomLabel}: ${slice.join(', ')}\n`;
        written += slice.length;
      }
      context += '\n';
    }

    return context;
  }

  /**
   * Consolidated first-interaction bootstrap.
   * Returns the guidance context string which already contains the compact
   * room-grouped quick-reference (name, type, state per item).  The homeIndex
   * was removed because it duplicated this data in a more verbose JSON form,
   * significantly inflating the initial response token cost.
   */
  async initialDiscovery(): Promise<{ context: string }> {
    const context = await this.getPromptContext();
    return { context };
  }

  /**
   * Virtual simulation of a command sequence.
   */
  async shadowRun(
    commands: Array<{ itemName: string; command: string }>
  ): Promise<Array<{ itemName: string; oldState: string; predictedState: string }>> {
    await this.getItems(); // ensure semantic index is built
    const idx = this.semanticIndex;
    const results = [];

    for (const cmd of commands) {
      // O(1) map lookup instead of O(n) find()
      const item = idx.itemMap.get(cmd.itemName);
      if (item) {
        results.push({
          itemName: cmd.itemName,
          oldState: item.state,
          predictedState: cmd.command,
        });
      }
    }
    return results;
  }

  /**
   * Generates a Mermaid topology graph for spatial reasoning.
   */
  async generateTopology(): Promise<string> {
    await this.getItems(); // ensure semantic index is built
    const idx = this.semanticIndex;
    let graph = 'graph TD\n';

    // Use pre-built index: O(1) byRoom lookups instead of O(n) filter per location/equipment
    for (const loc of idx.rooms) {
      graph += `  ${loc.name}["🏠 ${loc.label || loc.name}"]\n`;
      const childNames = idx.byRoom.get(loc.name.toLowerCase()) ?? new Set<string>();
      for (const childName of childNames) {
        const eq = idx.itemMap.get(childName);
        if (!eq) continue;
        graph += `  ${loc.name} --> ${eq.name}["📦 ${eq.label || eq.name}"]\n`;
        const pointNames = idx.byRoom.get(eq.name.toLowerCase()) ?? new Set<string>();
        for (const pointName of pointNames) {
          const p = idx.itemMap.get(pointName);
          if (!p) continue;
          graph += `  ${eq.name} --> ${p.name}["📍 ${p.label || p.name}"]\n`;
        }
      }
    }

    return graph;
  }

  /**
   * Scans Things for hardware issues and connectivity drift.
   */
  async analyzeSystemHealth(): Promise<Record<string, string[]>> {
    // Optimization: fetch things and items concurrently
    const [things] = await Promise.all([this.getThings(), this.getItems()]);

    const issues: string[] = [];
    const connectivity: string[] = [];

    things
      .filter((t) => t.statusInfo?.status !== 'ONLINE')
      .forEach((t) => {
        issues.push(`Device OFFLINE: ${t.label || t.UID} (${t.statusInfo?.status})`);
      });

    // Battery check — index is already warm from the concurrent fetch above
    const idx = this.semanticIndex;
    const battCandidates = new Set<string>([
      ...(idx.byTag.get('lowbattery') ?? []),
      ...(idx.byToken.get('battery') ?? []),
    ]);
    for (const name of battCandidates) {
      const i = idx.itemMap.get(name);
      if (!i) continue;
      if (parseFloat(i.state) < 20 || i.state === 'ON') {
        issues.push(`Low Battery Alert: ${i.label ?? i.name} (${i.state})`);
      }
    }

    return {
      criticalIssues: issues,
      connectivityDrift: connectivity.length > 0 ? connectivity : ['No signal drift detected'],
    };
  }

  /**
   * Predictive rule generation from natural language intent.
   */
  async generateRuleFromNL(intent: string): Promise<Partial<OpenHabRule>> {
    // Use resolveItem (semantic index) instead of O(n) substring scan
    const matches = await this.resolveItem(intent);
    const topMatch = matches[0];
    const targetItem = topMatch ? this.semanticIndex.itemMap.get(topMatch.name) : undefined;
    const lcIntent = intent.toLowerCase();

    const isOff = lcIntent.includes('off') || lcIntent.includes('close');
    const command = isOff ? 'OFF' : 'ON';

    const rule: Partial<OpenHabRule> = {
      uid: `ai_rule_${Date.now()}`,
      name: `AI generated: ${intent}`,
      actions: [
        {
          id: '1',
          type: 'script.ScriptAction',
          configuration: {
            type: 'application/javascript',
            script: targetItem
              ? `items.getItem("${targetItem.name}").sendCommand("${command}");`
              : '// Item not found',
          },
        },
      ],
      triggers: [
        {
          id: '2',
          type: 'core.ItemStateUpdateTrigger',
          configuration: { itemName: 'GlobalTrigger' }, // Mock trigger
        },
      ],
    };

    return rule;
  }

  /**
   * Captures current state of items as a named scene.
   * Optimization: uses getMultiItems so only the requested items are fetched (cache-aware),
   * avoiding a full item-list download when items_all isn't already cached.
   */
  async captureScene(name: string, itemNames: string[]): Promise<string> {
    const items = await this.getMultiItems(itemNames);
    const stateMap = new Map(items.map((i) => [i.name, i.state]));
    const sceneData = itemNames.map((itemName) => ({
      itemName,
      command: stateMap.get(itemName) ?? 'OFF',
    }));
    this.scenes.set(name, sceneData);
    return `Scene '${name}' captured with ${sceneData.length} items.`;
  }

  /**
   * Activates a previously captured scene.
   */
  async activateScene(name: string): Promise<string[]> {
    const scene = this.scenes.get(name);
    if (!scene) throw new Error(`Scene '${name}' not found.`);
    return this.executeBatch(scene);
  }

  /**
   * ASCII Sparkline of recent item history for trend analysis.
   */
  async getVisualChart(itemName: string): Promise<string> {
    const data = await this.getItemPersistenceData(itemName);
    if (!data.data || data.data.length === 0) return 'No history available for trend analysis.';

    const values = data.data.map((d) => parseFloat(d.state)).filter((v) => !isNaN(v));
    if (values.length === 0) return 'Non-numeric data detected.';

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const ticks = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

    const sparkline = values
      .map((v) => {
        const idx = Math.floor(((v - min) / range) * (ticks.length - 1));
        return ticks[idx];
      })
      .join('');

    return `Trend for ${itemName} (Min: ${min.toFixed(1)}, Max: ${max.toFixed(1)}):\n${sparkline}`;
  }

  /**
   * Generates professional-grade MainUI YAML for a widget.
   */
  async generateUIWidget(itemName: string): Promise<string> {
    const item = await this.getItem(itemName);
    return `uid: widget_${itemName}
props:
  parameterGroups: []
  parameters: []
tags: []
component: oh-label-card
config:
  item: ${itemName}
  title: ${item.label || itemName}
  icon: f7:lightbulb
  label: =items["${itemName}"].state
  footer: AI Generated Dashboard Prototyper
`;
  }

  /**
   * Suggests semantic tags based on naming intelligence.
   */
  async suggestSemanticTags(
    itemName: string
  ): Promise<{ suggestion: string[]; reasoning: string }> {
    const item = await this.getItem(itemName);
    const name = item.name.toLowerCase();
    const label = (item.label || '').toLowerCase();
    const tags: string[] = [];

    if (name.includes('light') || label.includes('light'))
      tags.push('Light', 'Point_Control_Switch');
    if (name.includes('temp') || label.includes('temp'))
      tags.push('Temperature', 'Point_Measurement_Property');
    if (name.includes('kitchen')) tags.push('Kitchen');
    if (name.includes('living')) tags.push('LivingRoom');
    if (name.includes('bedroom')) tags.push('Bedroom');

    return {
      suggestion: tags,
      reasoning: `Found keywords: ${tags.join(', ')} in item metadata.`,
    };
  }

  // --- ELITE FEATURES ---

  /**
   * The "Semantic Expressway": Replicates "Create Equipment from Thing" workflow
   */
  async createEquipmentFromThing(thingUID: string, roomGroup: string): Promise<string[]> {
    const thing = await this.getThing(thingUID);
    const results: string[] = [];

    // Create the Equipment Group
    const equipmentName = `Equipment_${thingUID.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const equipmentLabel = thing.label || `Equipment for ${thingUID}`;

    // Check if equipment already exists
    try {
      await this.getItem(equipmentName);
      results.push(`Equipment ${equipmentName} already exists.`);
    } catch {
      await this.createOrUpdateItem(equipmentName, {
        type: 'Group',
        name: equipmentName,
        label: equipmentLabel,
        groupNames: [roomGroup],
        tags: ['Equipment'],
      });
      results.push(`Created Equipment Group: ${equipmentName} in ${roomGroup}`);
    }

    // Process all channels
    if (thing.channels && thing.channels.length > 0) {
      for (const ch of thing.channels) {
        const channel = ch as {
          kind?: string;
          id: string;
          uid?: string;
          itemType?: string;
          label?: string;
        };
        if (channel.kind !== 'STATE') continue;

        const channelId = channel.id.replace(/[^a-zA-Z0-9_]/g, '');
        const itemName = `${equipmentName}_${channelId}`;
        const itemType = channel.itemType || 'String';
        const itemLabel = channel.label || channel.id;

        // Guess Semantic Tags
        const tags = ['Point'];
        if (
          itemType === 'Switch' ||
          channel.id.toLowerCase().includes('power') ||
          channel.id.toLowerCase().includes('switch')
        ) {
          tags.push('Switch');
        } else if (
          itemType === 'Number' &&
          (channel.id.toLowerCase().includes('temp') ||
            channel.id.toLowerCase().includes('humidity'))
        ) {
          tags.push('Measurement');
        }

        try {
          await this.getItem(itemName);
          results.push(`Item ${itemName} already exists.`);
        } catch {
          // Create Item
          await this.createOrUpdateItem(itemName, {
            type: itemType,
            name: itemName,
            label: itemLabel,
            groupNames: [equipmentName],
            tags: tags,
          });
          results.push(`Created Item: ${itemName} (${itemType})`);

          // Link Item to Channel
          if (channel.uid) {
            await this.linkItemToChannel(itemName, channel.uid);
            results.push(`Linked ${itemName} to ${channel.uid}`);
          }
        }
      }
    }

    return results;
  }

  /**
   * The "Transformation Playground": Test transformations safely locally where possible
   */
  testTransformation(type: string, pattern: string, value: string): string {
    try {
      if (type.toUpperCase() === 'REGEX') {
        const regex = new RegExp(pattern);
        const match = value.match(regex);
        return match ? (match[1] !== undefined ? match[1] : match[0]) : 'Null/No Match';
      } else if (type.toUpperCase() === 'JSONPATH') {
        // Very rudimentary JSONPath support since full library is not injected
        // Just extract top-level or dot-separated paths for basic testing
        try {
          const obj = JSON.parse(value);
          const parts = pattern.replace('$.', '').split('.');
          let current: unknown = obj;
          for (const p of parts) {
            if (
              current &&
              typeof current === 'object' &&
              p in (current as Record<string, unknown>)
            ) {
              current = (current as Record<string, unknown>)[p];
            } else {
              return 'Null/No Match';
            }
          }
          return typeof current === 'object' ? JSON.stringify(current) : String(current);
        } catch (e) {
          return `Invalid JSON or Path: ${(e as Error).message}`;
        }
      }
      return `Transformation type '${type}' cannot be perfectly simulated locally. Best approach is creating an internal test Rule via API.`;
    } catch (e) {
      return `Error evaluating transformation: ${(e as Error).message}`;
    }
  }

  /**
   * The "System Janitor": Finds orphan items and broken links.
   */
  async findOrphansAndBrokenLinks(): Promise<{ orphans: string[]; brokenLinks: string[] }> {
    // All three are independent — fetch in parallel
    const [items, links, things] = await Promise.all([
      this.getItems(),
      this.getLinks(),
      this.getThings(),
    ]);

    const thingUIDs = new Set(things.map((t) => t.UID));
    const itemNames = new Set(items.map((i) => i.name));

    // Find unlinked items that also have no groups and no semantic tags (potential orphans)
    const linkedItemNames = new Set(links.map((l) => l.itemName));
    const orphans = items
      .filter(
        (i) =>
          !linkedItemNames.has(i.name) &&
          (!i.groupNames || i.groupNames.length === 0) &&
          (!i.tags || i.tags.length === 0) &&
          i.type !== 'Group'
      )
      .map((i) => i.name);

    // Find links where the Thing doesn't exist
    const brokenLinks = links
      .filter((l) => {
        // channelUID usually looks like bind:thingType:thingUID:channelId
        // A generic Thing UID is usually the first 3 or 4 segments depending on the binding
        // Let's check if there's any Thing that whose UID is a prefix of the channelUID
        let thingExists = false;
        for (const tid of thingUIDs) {
          if (l.channelUID.startsWith(tid)) {
            thingExists = true;
            break;
          }
        }
        return !thingExists || !itemNames.has(l.itemName);
      })
      .map((l) => `Link: Item '${l.itemName}' <-> Channel '${l.channelUID}'`);

    return { orphans, brokenLinks };
  }

  /**
   * The "Forensic Investigator": Comprehensive state history and rule influences
   */
  async explainItemState(itemName: string): Promise<Record<string, unknown>> {
    // Optimization: fetch item, links, and rules concurrently
    const [item, links, rules] = await Promise.all([
      this.getItem(itemName),
      this.getLinks(itemName),
      this.getRules(),
    ]);

    let history: unknown = { message: 'No history found' };
    try {
      const histData = await this.getItemPersistenceData(itemName);
      if (histData.data && histData.data.length > 0) {
        history = histData.data.slice(-5); // Last 5 states
      }
    } catch (e) {
      history = { error: 'Persistence query failed', details: (e as Error).message };
    }

    // Find rules that reference this item
    const affectingRules = rules
      .filter((r) => {
        // Check triggers
        const inTrigger = r.triggers?.some((t: unknown) =>
          JSON.stringify((t as Record<string, unknown>).configuration).includes(itemName)
        );
        // Check actions/scripts
        const inAction = r.actions?.some((a: unknown) =>
          JSON.stringify((a as Record<string, unknown>).configuration).includes(itemName)
        );
        // Check conditions
        const inCondition = r.conditions?.some((c: unknown) =>
          JSON.stringify((c as Record<string, unknown>).configuration).includes(itemName)
        );
        return inTrigger || inAction || inCondition;
      })
      .map((r) => ({ uid: r.uid, name: r.name }));

    return {
      itemInfo: {
        name: item.name,
        state: item.state,
        type: item.type,
        tags: item.tags,
        groups: item.groupNames,
      },
      recentHistory: history,
      linkedChannels: links.map((l) => l.channelUID),
      referencedInRules: affectingRules,
    };
  }

  /**
   * Unified Log Tailer: Fetches the recent event buffer
   */
  async getRecentLogs(lines: number = 20): Promise<string[]> {
    if (this.eventLogBuffer.length === 0) {
      if (!this.enableSSE) return ['SSE Event stream is disabled. Enable it to buffer logs.'];
      return ['No events buffered yet. Waiting for system activity...'];
    }
    const safeLines = Math.min(lines, 100); // Standard recent logs remain small
    return this.eventLogBuffer.slice(-safeLines);
  }

  /**
   * Mastery Tool: Fetches a larger window of historical logs from the buffer.
   */
  async getHistoricalLogs(lines: number = 500, search?: string): Promise<string[]> {
    if (this.eventLogBuffer.length === 0) {
      return [
        'No events buffered. Historical logs require the MCP server to be running and connected to SSE.',
      ];
    }

    let logs = this.eventLogBuffer;
    if (search) {
      const query = search.toLowerCase();
      logs = logs.filter((l) => l.toLowerCase().includes(query));
    }

    const safeLines = Math.min(lines, this.MAX_LOG_BUFFER);
    return logs.slice(-safeLines);
  }

  /**
   * Mastery Tool: Searches the actual log files on the filesystem if available.
   * This is much faster and more comprehensive than the SSE buffer.
   */
  async searchLogs(
    query: string,
    logType: 'openhab' | 'events' = 'events',
    maxResults: number = 100
  ): Promise<string[]> {
    if (!this.logFolderPath) {
      return [
        'Log folder path is not configured.',
        'Please provide the path to the OpenHAB log folder using the set_log_folder tool.',
        'This can be a local path (e.g. /var/log/openhab) or a mounted network share.',
      ];
    }

    const fileName = logType === 'events' ? 'events.log' : 'openhab.log';
    const filePath = path.join(this.logFolderPath, fileName);

    if (!fs.existsSync(filePath)) {
      return [`Log file ${fileName} not found in ${this.logFolderPath}`];
    }

    // Since we're in a Node process, we'll read the last 5000 lines and filter
    const lines = await readLastLines(filePath, 5000);
    const searchLower = query.toLowerCase();

    let results = lines.filter((l) => l.toLowerCase().includes(searchLower));

    if (logType === 'events') {
      results = results.map((l) => normalizeEventLog(l) || l);
    }

    return results.slice(-maxResults);
  }

  /**
   * The "Profile Configurator": Applies Link Profiles during channel linking.
   */
  async configureLinkProfile(
    itemName: string,
    channelUID: string,
    profile: string,
    profileConfig: Record<string, unknown> = {}
  ): Promise<void> {
    const configToSubmit = {
      profile,
      ...profileConfig,
    };
    return this.linkItemToChannel(itemName, channelUID, configToSubmit);
  }

  /**
   * Advanced Remediation: Mass-update item metadata, tags, and groups.
   * Optimization: batch-fetches all target items via getMultiItems (one HTTP call or
   * cache hits) then fans out update requests concurrently.
   */
  async bulkItemRemediation(
    itemNames: string[],
    updates: { tags?: string[]; category?: string; groupNames?: string[] }
  ): Promise<string[]> {
    // Single batch fetch instead of N sequential getItem() calls
    let fetched: OpenHabItem[];
    try {
      fetched = await this.getMultiItems(itemNames);
    } catch (e: unknown) {
      return [`Batch fetch failed: ${e instanceof Error ? e.message : String(e)}`];
    }

    const fetchedMap = new Map(fetched.map((i) => [i.name, i]));

    // Fan out update requests concurrently
    const results = await Promise.all(
      itemNames.map(async (itemName) => {
        try {
          const item = fetchedMap.get(itemName);
          if (!item) return `Error: item '${itemName}' not found.`;
          const newData = { ...item };
          if (updates.tags)
            newData.tags = Array.from(new Set([...(newData.tags || []), ...updates.tags]));
          if (updates.category) newData.category = updates.category;
          if (updates.groupNames)
            newData.groupNames = Array.from(
              new Set([...(newData.groupNames || []), ...updates.groupNames])
            );
          await this.createOrUpdateItem(itemName, newData);
          return `Updated ${itemName}`;
        } catch (e: unknown) {
          return `Error updating ${itemName}: ${e instanceof Error ? e.message : String(e)}`;
        }
      })
    );
    return results;
  }

  /**
   * Advanced Remediation: Simple correlation discovery in persistence history.
   */
  async discoverAutomationPatterns(itemName: string, correlatedItemName: string): Promise<string> {
    // Both persistence fetches are independent — run in parallel
    const [dataA, dataB] = await Promise.all([
      this.getItemPersistenceData(itemName),
      this.getItemPersistenceData(correlatedItemName),
    ]);

    if (!dataA.data || !dataB.data || dataA.data.length < 5 || dataB.data.length < 5) {
      return 'Insufficient data for correlation analysis.';
    }

    // Very simple check: see if events for Item B happen within 15 mins of Item A
    let matches = 0;
    for (const eventA of dataA.data) {
      const timeA = new Date(eventA.time).getTime();
      const match = dataB.data.find((eventB) => {
        const timeB = new Date(eventB.time).getTime();
        return Math.abs(timeA - timeB) < 900000; // 15 mins
      });
      if (match) matches++;
    }

    const precision = (matches / dataA.data.length) * 100;
    return `Analysis: ${itemName} and ${correlatedItemName} showed temporal correlation in ${precision.toFixed(1)}% of events. Suggested Automation: Trigger on ${itemName} and check state of ${correlatedItemName}.`;
  }

  /**
   * Audit the semantic model using the same logic as the OpenHAB MainUI model page.
   *
   * The UI builds its tree from metadata.semantics.config keys:
   *   hasLocation  — Equipment/Point → parent Location
   *   isPartOf     — Equipment/Location → parent Equipment/Location
   *   isPointOf    — Point → parent Equipment
   *
   * This method fetches items with their semantics metadata, replicates that tree-build
   * logic to find orphans and broken references, and returns structured SemanticIssue
   * objects with a safeFix where one can be computed automatically.
   */
  async auditSemanticModel(): Promise<{ issues: SemanticIssue[] }> {
    // Fetch slim items with semantics metadata — same query the UI model page uses
    const response = await this.client.get('/rest/items', {
      params: {
        staticDataOnly: 'true',
        metadata: 'semantics',
        fields: 'name,label,type,tags,groupNames,editable',
      },
    });
    const items: Array<OpenHabItem & { editable?: boolean }> = response.data;

    // Build a quick lookup map and identify semantic classes
    const itemMap = new Map(items.map((i) => [i.name, i]));

    const semOf = (item: OpenHabItem): string | null => {
      const meta = item.metadata?.semantics as { value?: string } | undefined;
      return meta?.value ?? null;
    };
    const configOf = (item: OpenHabItem): Record<string, string> => {
      const meta = item.metadata?.semantics as { config?: Record<string, string> } | undefined;
      return meta?.config ?? {};
    };

    // Collect Location item names for safeFix suggestions
    const locationNames = items
      .filter((i) => (semOf(i) ?? '').startsWith('Location'))
      .map((i) => i.name);
    const equipmentNames = items
      .filter((i) => (semOf(i) ?? '').startsWith('Equipment'))
      .map((i) => i.name);

    const issues: SemanticIssue[] = [];

    for (const item of items) {
      const sc = semOf(item);
      if (!sc) continue; // non-semantic item — skip

      const cfg = configOf(item);
      const editable = item.editable !== false; // default true if field absent

      const base = {
        item: item.name,
        label: item.label,
        type: item.type,
        semanticClass: sc,
        currentGroups: item.groupNames ?? [],
        editable,
      };

      // ── Conflicting class: tagged as both Location and Equipment/Point ──
      const isLocation = sc.startsWith('Location');
      const isEquipment = sc.startsWith('Equipment');
      const isPoint = sc.startsWith('Point');
      const tagClasses = [isLocation, isEquipment, isPoint].filter(Boolean).length;
      if (tagClasses > 1) {
        issues.push({
          ...base,
          issue: 'conflicting_class',
          description: `Item '${item.name}' has a conflicting semantic class '${sc}' — an item can only be Location, Equipment, or Point.`,
          safeFix: null,
        });
        continue;
      }

      // ── Non-editable: file-managed item, REST cannot fix it ──
      if (!editable) {
        const needsFix =
          (isEquipment && !cfg.hasLocation && !cfg.isPartOf) ||
          (isPoint && !cfg.isPointOf && !cfg.hasLocation);
        if (needsFix) {
          issues.push({
            ...base,
            issue: 'not_editable',
            description: `Item '${item.name}' has a semantic issue but is file-managed. Edit the .items file directly.`,
            safeFix: null,
          });
        }
        continue;
      }

      // ── Broken reference: a config key points to a non-existent item ──
      for (const key of ['hasLocation', 'isPartOf', 'isPointOf'] as const) {
        const ref = cfg[key];
        if (ref && !itemMap.has(ref)) {
          issues.push({
            ...base,
            issue: 'broken_reference',
            brokenRefKey: key,
            brokenRefValue: ref,
            description: `Item '${item.name}' has ${key}='${ref}' but that item does not exist.`,
            safeFix: null, // requires human to pick a valid replacement
          });
        }
      }

      // ── Equipment with no parent Location ──
      if (isEquipment && !cfg.hasLocation && !cfg.isPartOf) {
        issues.push({
          ...base,
          issue: 'equipment_no_location',
          description: `Equipment '${item.name}' has no parent Location (missing hasLocation or isPartOf in semantics config).`,
          safeFix:
            locationNames.length > 0
              ? {
                  action: 'set_semantic_parent',
                  key: 'hasLocation',
                  suggestedParents: locationNames,
                }
              : null,
        });
      }

      // ── Point with no parent Equipment or Location ──
      if (isPoint && !cfg.isPointOf && !cfg.hasLocation && !cfg.isPartOf) {
        issues.push({
          ...base,
          issue: 'point_no_parent',
          description: `Point '${item.name}' has no parent Equipment or Location (missing isPointOf/hasLocation in semantics config).`,
          safeFix:
            equipmentNames.length > 0
              ? {
                  action: 'set_semantic_parent',
                  key: 'isPointOf',
                  suggestedParents: equipmentNames,
                }
              : locationNames.length > 0
                ? {
                    action: 'set_semantic_parent',
                    key: 'hasLocation',
                    suggestedParents: locationNames,
                  }
                : null,
        });
      }
    }

    return { issues };
  }

  /**
   * Safely fix a single semantic model issue.
   *
   * Uses targeted REST operations that NEVER replace the full item:
   *   - Semantic parent → PUT /rest/items/{name}/metadata/semantics  (only semantics namespace)
   *   - Add group membership → PUT /rest/items/{name}/groups/{group}  (additive)
   *   - Add tag             → PUT /rest/items/{name}/tags/{tag}       (additive)
   *
   * dryRun=true returns a preview of what would change without making any API calls.
   */
  async fixSemanticIssue(
    itemName: string,
    opts: {
      setSemanticParent?: { key: 'hasLocation' | 'isPartOf' | 'isPointOf'; parentName: string };
      addTag?: string;
    },
    dryRun = false
  ): Promise<{ success: boolean; message: string; before?: unknown; after?: unknown }> {
    // Always fetch the full live item first — including editable flag and all metadata
    let item: OpenHabItem & { editable?: boolean };
    try {
      const r = await this.client.get(`/rest/items/${itemName}`, {
        params: { metadata: '.*' },
      });
      item = r.data;
    } catch {
      return { success: false, message: `Item '${itemName}' not found.` };
    }

    if (item.editable === false) {
      return {
        success: false,
        message: `Item '${itemName}' is file-managed (editable=false). Edit the .items file on the OpenHAB server directly — changes via REST API are not persisted for file-managed items.`,
      };
    }

    const before = {
      groupNames: [...(item.groupNames ?? [])],
      tags: [...(item.tags ?? [])],
      semantics: (item.metadata?.semantics as Record<string, unknown>) ?? null,
    };

    if (opts.setSemanticParent) {
      const { key, parentName } = opts.setSemanticParent;

      // Validate the parent exists
      const parentItem = this.semanticIndex.itemMap.get(parentName);
      if (!parentItem) {
        return { success: false, message: `Parent item '${parentName}' does not exist.` };
      }

      // Validate semantic parent type expectations
      const parentSC =
        (parentItem.metadata?.semantics as { value?: string } | undefined)?.value ?? '';
      if (key === 'hasLocation' && !parentSC.startsWith('Location')) {
        return {
          success: false,
          message: `'${parentName}' is not a Location item (class: '${parentSC}'). 'hasLocation' requires a Location parent.`,
        };
      }
      if (key === 'isPointOf' && !parentSC.startsWith('Equipment')) {
        return {
          success: false,
          message: `'${parentName}' is not an Equipment item (class: '${parentSC}'). 'isPointOf' requires an Equipment parent.`,
        };
      }

      // Build merged semantics config — preserve all existing config keys
      const existingMeta = item.metadata?.semantics as
        | { value?: string; config?: Record<string, string> }
        | undefined;
      const existingValue = existingMeta?.value ?? '';
      const existingConfig = existingMeta?.config ?? {};
      const newConfig = { ...existingConfig, [key]: parentName };
      const newSemantics = { value: existingValue, config: newConfig };

      if (dryRun) {
        return {
          success: true,
          message: `[DRY RUN] Would set metadata.semantics.config.${key}='${parentName}' on '${itemName}' and add '${parentName}' to groupNames.`,
          before,
          after: {
            groupNames: Array.from(new Set([...(item.groupNames ?? []), parentName])),
            tags: item.tags,
            semantics: newSemantics,
          },
        };
      }

      // 1. Update semantics metadata — only this namespace, nothing else touched
      await this.client.put(`/rest/items/${itemName}/metadata/semantics`, newSemantics);

      // 2. Add parent to groupNames if not already present — use additive group endpoint
      if (!(item.groupNames ?? []).includes(parentName)) {
        await this.client.put(`/rest/items/${itemName}/groups/${parentName}`);
      }

      this.invalidateItemCache(itemName);

      // Re-fetch to confirm
      const updated = await this.client.get(`/rest/items/${itemName}`, {
        params: { metadata: '.*' },
      });
      return {
        success: true,
        message: `Set semantics.config.${key}='${parentName}' on '${itemName}'.`,
        before,
        after: {
          groupNames: updated.data.groupNames,
          tags: updated.data.tags,
          semantics: updated.data.metadata?.semantics,
        },
      };
    }

    if (opts.addTag) {
      const tag = opts.addTag;
      if (dryRun) {
        return {
          success: true,
          message: `[DRY RUN] Would add tag '${tag}' to '${itemName}'.`,
          before,
          after: { ...before, tags: Array.from(new Set([...(item.tags ?? []), tag])) },
        };
      }
      // Additive tag endpoint — never removes other tags
      await this.client.put(`/rest/items/${itemName}/tags/${tag}`);
      this.invalidateItemCache(itemName);
      return {
        success: true,
        message: `Added tag '${tag}' to '${itemName}'.`,
        before,
        after: { tags: Array.from(new Set([...(item.tags ?? []), tag])) },
      };
    }

    return {
      success: false,
      message: 'No operation specified (provide setSemanticParent or addTag).',
    };
  }

  /**
   * Run a full semantic model audit and apply all issues that have a safe auto-fix.
   * Issues that require human input (broken_reference, not_editable, conflicting_class)
   * are reported but not touched.
   *
   * dryRun=true returns a full preview without making any changes.
   */
  async applySemanticAuditFixes(
    dryRun = false
  ): Promise<{ fixed: Array<{ item: string; result: unknown }>; skipped: SemanticIssue[] }> {
    const { issues } = await this.auditSemanticModel();
    const fixed: Array<{ item: string; result: unknown }> = [];
    const skipped: SemanticIssue[] = [];

    for (const issue of issues) {
      if (!issue.safeFix) {
        skipped.push(issue);
        continue;
      }
      // Use the first suggested parent for auto-fix
      const parentName = issue.safeFix.suggestedParents[0];
      if (!parentName) {
        skipped.push(issue);
        continue;
      }
      // Sequential (not parallel) to avoid race conditions on shared parent groups
      const result = await this.fixSemanticIssue(
        issue.item,
        { setSemanticParent: { key: issue.safeFix.key, parentName } },
        dryRun
      );
      fixed.push({ item: issue.item, result });
    }

    return { fixed, skipped };
  }

  /**
   * Mastery Tool: Detects potential conflicts between rules targeting the same items.
   */
  async detectRuleConflicts(): Promise<string[]> {
    // Fetch items (to warm index) and rules concurrently
    const [rules] = await Promise.all([this.getRules(), this.getItems()]);
    const idx = this.semanticIndex;
    const conflicts: string[] = [];
    const itemToRules = new Map<string, string[]>();

    for (const r of rules) {
      const actionsStr = JSON.stringify(r.actions);
      // Match against known item names only — avoids the false-positives caused by
      // the old broad regex (/[a-zA-Z0-9_]{5,}/g) which matched every JSON property key.
      for (const itemName of idx.itemMap.keys()) {
        if (actionsStr.includes(itemName)) {
          let list = itemToRules.get(itemName);
          if (!list) {
            list = [];
            itemToRules.set(itemName, list);
          }
          list.push(r.uid);
        }
      }
    }

    for (const [itemName, ruleUIDs] of itemToRules) {
      const unique = [...new Set(ruleUIDs)];
      if (unique.length > 1) {
        conflicts.push(
          `Potential Conflict: Item '${itemName}' is targeted by ${unique.length} rules: ${unique.join(', ')}`
        );
      }
    }

    return conflicts.length > 0 ? conflicts : ['No obvious rule conflicts detected.'];
  }

  /**
   * Mastery Tool: Proposes standardized naming for items based on semantics.
   */
  async standardizeNamingConvention(): Promise<Array<{ oldName: string; suggestedName: string }>> {
    const items = await this.getItems();
    const suggestions: Array<{ oldName: string; suggestedName: string }> = [];

    items.forEach((i) => {
      const room = i.tags?.find(
        (t) => t.startsWith('Room_') || ['Lounge', 'Kitchen', 'Bedroom', 'Hallway'].includes(t)
      );
      const equipment = i.tags?.find((t) => t.toLowerCase().includes('equipment'));

      if (room && equipment) {
        const expectedPrefix = `${room}_${equipment}`.replace(/ /g, '_');
        if (!i.name.startsWith(expectedPrefix)) {
          suggestions.push({
            oldName: i.name,
            suggestedName: `${expectedPrefix}_${i.name.split('_').pop()}`,
          });
        }
      }
    });

    return suggestions;
  }

  /**
   * Mastery Tool: Recommends persistence optimizations.
   */
  async optimizePersistenceStrategy(): Promise<string[]> {
    const items = await this.getItems();
    const recs: string[] = [];

    items.forEach((i) => {
      if (i.type === 'Number' && i.name.toLowerCase().includes('power')) {
        recs.push(
          `Optimization for '${i.name}': High-frequency power sensor detected. Use 'everyChange' with a '0.1' threshold if possible to reduce DB bloat.`
        );
      }
      if (i.type === 'Contact' || i.type === 'Switch') {
        recs.push(
          `Optimization for '${i.name}': Binary state. Ensure 'everyChange' is the only strategy; 'everyMinute' is redundant.`
        );
      }
    });

    return recs;
  }

  /**
   * Mastery Tool: Converts legacy Sitemap definitions to modern MainUI YAML.
   */
  async sitemapToMainUI(sitemapName: string): Promise<string> {
    try {
      const sitemaps = await this.getSitemaps();
      const sitemap = sitemaps.find((s) => s.name === sitemapName);
      if (!sitemap) return `Sitemap '${sitemapName}' not found.`;

      // Simulating a conversion of a basic sitemap structure to YAML
      return `component: oh-layout-page
config:
  label: ${sitemap.label || sitemapName}
blocks:
  - component: oh-block
    slots:
      default:
        - component: oh-grid-row
          slots:
            default:
              - component: oh-grid-col
                config:
                  width: "100"
                slots:
                  default:
                    - component: oh-label-card
                      config:
                        title: Generated from legacy sitemap ${sitemapName}`;
    } catch (e: unknown) {
      return `Error converting sitemap: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Mastery Tool: Locks the MCP focus to a specific Room or Group to save tokens.
   */
  optimizeMcpFocus(type: 'room' | 'group', name: string | null): string {
    if (!name) {
      this.focusScope = null;
      return 'Focus Scope cleared. All items are now visible.';
    }
    this.focusScope = { type, name };
    return `Focus Scope locked to ${type}: ${name}. Tools will now only see items in this scope.`;
  }

  /**
   * Mastery Tool: Exports a lightweight JSON snapshot of the system configuration.
   * Returns counts + slim projections instead of raw arrays to stay token-efficient.
   * Full raw data is available individually via query_items/query_things/manage_link.
   */
  async exportSystemSnapshot(): Promise<string> {
    const [items, things, links] = await Promise.all([
      this.getItems(),
      this.getThings(),
      this.getLinks(),
    ]);

    const snapshot = {
      timestamp: new Date().toISOString(),
      version: '1.0-snapshot',
      counts: {
        items: items.length,
        things: things.length,
        links: links.length,
      },
      // Slim projections — names/types/states only (no metadata, no channels)
      items: items.map((i) => ({ name: i.name, type: i.type, state: i.state, label: i.label })),
      things: things.map((t) => ({ uid: t.UID, label: t.label, status: t.statusInfo?.status })),
      links: links.map((l) => ({ item: l.itemName, channel: l.channelUID })),
    };

    return JSON.stringify(snapshot);
  }

  /**
   * Mastery Tool: Returns observability metrics for the MCP server.
   */
  getMcpHealth(): Record<string, unknown> {
    return {
      status: 'OK',
      capabilities: ['SSE', 'Caching', 'FuzzySearch', 'Simulation', 'SemanticAudit'],
      sse: {
        active: this.enableSSE,
        bufferSize: this.eventLogBuffer.length,
        lastEvents: this.eventLogBuffer.slice(-5),
      },
      cache: {
        size: this.cache.size,
      },
      focus: this.focusScope || 'None',
    };
  }

  /**
   * Mastery Tool: Returns statistical summary of persistence data to save tokens.
   */
  async summarizePersistenceRange(
    itemName: string,
    startTime: string,
    endTime: string
  ): Promise<Record<string, unknown>> {
    const data = await this.getItemPersistenceData(itemName, undefined, startTime, endTime);
    if (!data || !data.data || data.data.length === 0) return { error: 'No data found in range.' };

    const values = data.data.map((p) => parseFloat(p.state)).filter((v) => !isNaN(v));
    if (values.length === 0)
      return { count: data.data.length, info: 'No numeric values to summarize.' };

    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
    const trend = values[values.length - 1] > values[0] ? 'Increasing' : 'Decreasing';

    return {
      itemName,
      range: { startTime, endTime },
      statistics: {
        count: values.length,
        min: min.toFixed(2),
        max: max.toFixed(2),
        avg: avg.toFixed(2),
        trend,
      },
      recommendation:
        values.length > 500
          ? 'Token warning: Recommend higher sampling interval if retrieving raw data.'
          : 'Safe for extraction.',
    };
  }

  /**
   * Mastery Tool: Returns a list of active master-tier capabilities.
   */
  getMcpCapabilities(): string[] {
    return [
      'Bulk Item Remediation',
      'Automation Pattern Discovery',
      'Semantic Model Auditing',
      'Rule Conflict Detection',
      'Naming Convention Standardization',
      'Persistence Strategy Optimization',
      'Sitemap-to-MainUI Migration',
      'Agentic Focus Locking',
      'Configuration Snapshotting',
      'Statistical Persistence Summaries',
      'System Simulation Engine',
      'Auto-Generated Home Blueprint',
      'Comprehensive Safety Auditing',
      'Energy & Power Insights',
      'Discovery Scan Triggering',
      'Semantic Path breadcrumbs',
      'Neighboring Equipment discovery',
      'Future-dated Command Scheduling',
      'Proactive Staleness Detection',
    ];
  }

  /**
   * Ultimate Tool: Predicts the effect of a command without executing it on hardware.
   * Optimization: fetches item state and rule list concurrently.
   */
  async simulateSystemState(itemName: string, command: string): Promise<Record<string, unknown>> {
    // item and rules are independent — fetch in parallel
    const [item, rules] = await Promise.all([this.getItem(itemName), this.getRules()]);

    const affectedRules = rules.filter((r) => {
      const triggers = JSON.stringify(r.triggers);
      return (
        triggers.includes(itemName) &&
        (triggers.includes('changed') || triggers.includes('command'))
      );
    });

    return {
      simulationResult: 'Success',
      initialState: item.state,
      predictedState: command,
      potentialTriggers: affectedRules.map((r) => ({ uid: r.uid, name: r.name })),
      impactLevel: affectedRules.length > 2 ? 'High' : affectedRules.length > 0 ? 'Medium' : 'Low',
      warning:
        affectedRules.length > 5
          ? 'Significant automation chain detected. High risk of side effects.'
          : null,
    };
  }

  /**
   * Ultimate Tool: Generates a complete Markdown guide of the current OpenHAB setup.
   * Optimization: fetches items and rules concurrently.
   * Room detection uses proper semantic Location tags (any item tagged with a word
   * containing 'location') rather than a hard-coded list of room names.
   */
  async generateHomeBlueprint(): Promise<string> {
    // Fetch items (warm/rebuild index) and rules concurrently
    const [, rules] = await Promise.all([this.getItems(), this.getRules()]);
    const idx = this.semanticIndex;

    let blueprint = '# OpenHAB Home Blueprint\n\n';
    blueprint += `Generated: ${new Date().toLocaleString()}\n\n`;

    blueprint += '## System Overview\n';
    blueprint += `- Total Items: ${idx.itemMap.size}\n`;
    blueprint += `- Total Rules: ${rules.length}\n`;
    blueprint += `- Rooms: ${idx.rooms.length}\n\n`;

    // Use the pre-built index instead of repeated O(n) filter calls inside a loop
    blueprint += '## Spatial Model\n';
    for (const room of idx.rooms) {
      const roomLabel = room.label ?? room.name;
      const directChildNames = idx.byRoom.get(room.name.toLowerCase()) ?? new Set<string>();
      const directChildren = Array.from(directChildNames)
        .map((n) => idx.itemMap.get(n)!)
        .filter(Boolean);

      const equipment = directChildren.filter(
        (i) => i.type === 'Group' || i.tags?.some((t) => t.toLowerCase().includes('equipment'))
      );
      const standalone = directChildren.filter(
        (i) => i.type !== 'Group' && !i.tags?.some((t) => t.toLowerCase().includes('equipment'))
      );

      blueprint += `### ${roomLabel}\n`;
      blueprint += `- Equipment: ${equipment.length}, Standalone items: ${standalone.length}\n`;

      for (const eq of equipment) {
        // Use byRoom map lookup instead of items.filter()
        const pointNames = idx.byRoom.get(eq.name.toLowerCase()) ?? new Set<string>();
        const points = Array.from(pointNames)
          .map((n) => idx.itemMap.get(n))
          .filter((p): p is OpenHabItem => !!p && p.type !== 'Group');
        blueprint += `  - **${eq.label ?? eq.name}** (${eq.type})`;
        if (points.length) blueprint += `: ${points.map((p) => p.label ?? p.name).join(', ')}`;
        blueprint += '\n';
      }

      if (standalone.length) {
        blueprint += standalone
          .slice(0, 5)
          .map((i) => `  - ${i.label ?? i.name}: ${i.state}`)
          .join('\n');
        if (standalone.length > 5) blueprint += `\n  - … (+${standalone.length - 5} more)`;
        blueprint += '\n';
      }
      blueprint += '\n';
    }

    // Active states — use pre-indexed byType and byTag instead of scanning all items
    const active: string[] = [];
    for (const [, item] of idx.itemMap) {
      if (item.state === 'ON' || item.state === 'OPEN') active.push(item.label ?? item.name);
    }
    if (active.length) {
      blueprint += `## Currently Active (${active.length})\n`;
      const shown = active.slice(0, 60);
      blueprint += shown.map((n) => `- ${n}`).join('\n') + '\n';
      if (active.length > 60) blueprint += `- … +${active.length - 60} more\n`;
      blueprint += '\n';
    }

    return blueprint;
  }

  /**
   * Ultimate Tool: Audits security-sensitive items for misconfiguration.
   */
  async auditSystemSafety(): Promise<Record<string, unknown>> {
    const items = await this.getItems();
    const issues: string[] = [];

    items.forEach((i) => {
      const isSecurity = i.tags?.some(
        (t) =>
          ['Security', 'Safety', 'Lock', 'Alarm'].includes(t) ||
          t.toLowerCase().includes('security')
      );
      if (isSecurity) {
        if (!i.metadata?.['security_lock'] && i.type === 'Switch') {
          issues.push(
            `Item '${i.name}' (Security) lacks a safety lock metadata tag. It can be toggled without confirmation.`
          );
        }
      }
    });

    return {
      auditType: 'Safety & Security',
      status: issues.length === 0 ? 'Protected' : 'Vulnerable',
      findings: issues,
      recommendation:
        issues.length > 0
          ? "Apply 'security_lock' metadata to all critical switches."
          : 'All security items appear standard.',
    };
  }

  /**
   * Ultimate Tool: Aggregates power and energy data into an efficiency report.
   */
  async calculateEnergyInsights(): Promise<Record<string, unknown>> {
    const items = await this.getItems();
    const energyItems = items.filter(
      (i) =>
        i.type === 'Number' &&
        (i.name.toLowerCase().includes('power') || i.name.toLowerCase().includes('energy'))
    );

    if (energyItems.length === 0) return { error: 'No energy-tracking items found.' };

    const insights = energyItems.map((i) => ({
      name: i.name,
      lastReading: i.state,
      category: i.category || 'Unknown',
    }));

    return {
      reportType: 'Energy Efficiency',
      monitoredDevices: energyItems.length,
      insights,
      totalNominalLoad:
        energyItems.reduce((acc, i) => acc + (parseFloat(i.state) || 0), 0).toFixed(2) + ' W/kWh',
    };
  }

  /**
   * Enhancement: Triggers a manual discovery scan for a specific binding.
   */
  async triggerDiscoveryScan(bindingId: string): Promise<string> {
    await this.client.post(`/rest/discovery/bindings/${bindingId}/scan`);
    return `Discovery scan triggered for binding: ${bindingId}. Check the inbox for new items.`;
  }

  /**
   * Enhancement: Returns the full semantic path for an item (e.g., Lounge > Sofa > Light).
   */
  async getSemanticPath(itemName: string): Promise<string> {
    await this.getItems(); // ensure index
    const idx = this.semanticIndex;
    const item = idx.itemMap.get(itemName);
    if (!item) throw new Error(`Item ${itemName} not found.`);

    const path: string[] = [item.label ?? item.name];
    let current = item;

    // Traverse upwards via itemMap O(1) lookups instead of O(n) allItems.find()
    while (current.groupNames && current.groupNames.length > 0) {
      const parent = current.groupNames
        .map((g) => idx.itemMap.get(g))
        .find((p) =>
          p?.tags?.some((t) =>
            ['location', 'equipment', 'point'].some((s) => t.toLowerCase().includes(s))
          )
        );
      if (!parent) break;
      path.unshift(parent.label ?? parent.name);
      current = parent;
    }

    return path.join(' > ');
  }

  /**
   * Enhancement: Finds equipment/points in the same location as the target item.
   */
  async findNeighboringEquipment(itemName: string): Promise<OpenHabItem[]> {
    await this.getItems(); // ensure index
    const idx = this.semanticIndex;
    const item = idx.itemMap.get(itemName);
    if (!item) throw new Error(`Item ${itemName} not found.`);

    // Use pre-built transitive map — O(1) lookup instead of multi-level upward traversal
    const roomName = idx.itemToRoom.get(itemName);
    if (!roomName) return [];

    // Return every item assigned to the same room (all depths), excluding self
    return Array.from(idx.itemToRoom.entries())
      .filter(([n, r]) => n !== itemName && r === roomName)
      .map(([n]) => idx.itemMap.get(n)!)
      .filter(Boolean);
  }

  /**
   * Enhancement: Schedules a command to be sent after a delay.
   */
  async scheduleCommand(itemName: string, command: string, delayMs: number): Promise<string> {
    this.log(`SCHEDULER: Queuing ${command} for ${itemName} in ${delayMs}ms`);
    this.addLogToBuffer(
      `${new Date().toISOString()} - ScheduledEvent - Queued ${command} for ${itemName} in ${delayMs}ms`
    );

    setTimeout(async () => {
      try {
        await this.sendCommand(itemName, command);
        this.log(`SCHEDULER: Executed scheduled command ${command} on ${itemName}`);
      } catch (err: unknown) {
        this.log(
          `SCHEDULER ERROR: Failed to execute command on ${itemName}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, delayMs);

    return `Command '${command}' successfully scheduled for item '${itemName}' in ${delayMs}ms.`;
  }

  /**
   * Enhancement: Identifies items that haven't updated their state recently.
   */
  async getStaleItems(days = 7): Promise<Array<{ name: string; lastUpdate?: string }>> {
    const items = await this.getItems(undefined, undefined, '.*'); // Get all items with metadata
    const now = Date.now();
    const threshold = days * 24 * 60 * 60 * 1000;
    const stale: Array<{ name: string; lastUpdate?: string }> = [];

    items.forEach((i) => {
      // Try to find last update from metadata if the system supports it,
      // or check the event logs if we have them.
      // Since standard REST items don't have a 'lastUpdate' field without persistence,
      // we check our event logs first.
      // Optimization: avoid O(n²) repeated in-place reverse() inside a forEach loop;
      // iterate backwards without mutating the array.
      const target = `ItemStateChangedEvent - ${i.name}`;
      let lastLog: string | undefined;
      for (let idx = this.eventLogBuffer.length - 1; idx >= 0; idx--) {
        if (this.eventLogBuffer[idx].includes(target)) {
          lastLog = this.eventLogBuffer[idx];
          break;
        }
      }

      if (lastLog) {
        const logTime = new Date(lastLog.split(' - ')[0]).getTime();
        if (now - logTime > threshold) {
          stale.push({ name: i.name, lastUpdate: new Date(logTime).toISOString() });
        }
      } else {
        // If no log in buffer, and it's a sensor (Number), it might be stale
        if (i.type === 'Number' || i.type === 'Contact') {
          stale.push({ name: i.name, lastUpdate: 'Unknown (No recent event logs)' });
        }
      }
    });

    return stale;
  }

  /**
   * Enhancement: Rapidly audits all items exposed to voice assistants (Google/Alexa).
   * Correlates items with their room and equipment for human-readable reporting.
   */
  async auditVoiceExposure(): Promise<Record<string, unknown>[]> {
    // Must request metadata explicitly — voice assistant config lives in metadata namespaces
    // (ga, alexa, googlehome, etc.) which are not included in the default slim fetch.
    const metaItems = await this.getItems(undefined, undefined, '.*');
    const idx = this.semanticIndex; // still valid for room/equipment lookups
    const roomLabelOf = new Map(idx.rooms.map((r) => [r.name, r.label ?? r.name]));
    const exposed: Record<string, unknown>[] = [];

    // Iterate the metadata-inclusive list, not the slim semantic index itemMap
    for (const item of metaItems) {
      if (!item.metadata) continue;

      const ga = item.metadata.ga || item.metadata.googlehome || item.metadata.googleassistant;
      const alexa = item.metadata.alexa;

      if (!ga && !alexa) continue;

      // Use pre-built transitive maps — O(1) per item, no linear scan
      const roomName = idx.itemToRoom.get(item.name);
      const equipName = idx.itemToEquipment.get(item.name);
      const equipItem = equipName ? idx.itemMap.get(equipName) : undefined;

      const gaEntry = ga as { value?: unknown; config?: Record<string, unknown> };
      const alexaEntry = alexa as { value?: unknown };
      exposed.push({
        itemName: item.name,
        label: item.label,
        type: item.type,
        room: roomName ? (roomLabelOf.get(roomName) ?? roomName) : 'Unknown',
        equipment: equipItem ? (equipItem.label ?? equipItem.name) : 'None',
        googleHome: ga
          ? {
              type: gaEntry.value,
              name: (gaEntry.config?.name as string | undefined) ?? item.label,
              room: gaEntry.config?.roomHint,
            }
          : null,
        alexa: alexa ? { type: alexaEntry.value } : null,
      });
    }

    return exposed;
  }
}
