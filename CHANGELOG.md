# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - 2026-07-03

### Performance

- **Token Optimization**: Streamlined JSON payloads returned by `getSchema`, `searchItems`, `resolveItem`, and `getRoomInventory` by omitting redundant labels (matching the item name) and filtering out empty tag/group arrays. Reduces token usage by up to 60%.
- **Pre-compiled Zod Schemas**: Moved schema compilation to module level in `src/tools.ts`, avoiding runtime compilation overhead on every MCP call.
- **Asynchronous Log Parsing**: Refactored `readLastLines` in `src/log-parser.ts` to use non-blocking asynchronous Node.js `fs.promises` instead of synchronous file API calls.

### Added

- **SSE Cache Invalidation on Reconnect**: Automatically invalidates caches and triggers background refetches upon SSE stream reconnection to ensure no state updates are missed.

## [1.3.2] - 2026-04-24

### Performance

- **`addLogToBuffer`**: Replaced O(n) `Array.shift()` per SSE event with a periodic batch-slice, eliminating linear memory moves on every event in high-activity homes.
- **`shadowRun`**: Replaced O(n) `items.find()` with O(1) `semanticIndex.itemMap.get()` lookup.
- **`generateTopology`**: Replaced O(n²) nested `items.filter()` loops with O(1) `byRoom`/`itemMap` index lookups (same pattern as `generateHomeBlueprint`).
- **`getSystemSummary`**: Eliminated separate type-count loop; now reads directly from `semanticIndex.byType` map sizes built during `getItems()`.
- **`generateSystemBoilerplate`**: Eliminated second array pass for location items; uses `semanticIndex.itemMap` and `semanticIndex.rooms` from the existing warm index.

### Fixed

- **`detectRuleConflicts`**: Replaced broad regex `/[a-zA-Z0-9_]{5,}/g` (which matched every JSON property name, producing large numbers of false-positive conflicts) with exact lookup against known item names from the semantic index.

### Changed

- **`index.ts`**: Expanded MCP capability advertisement (`resources.templates`, `resources.list`, `tools.list`, `tools.call`, `tools.schemas`) so clients that require explicit capability metadata (e.g. newer VS Code model runtimes) can discover all tools and resources.

## [1.3.0] - 2026-03-16

## [1.3.1] - 2026-03-25

### Changed

- Documentation improvements and README clarifications.
- Tests are excluded from releases and publishing (kept locally).
- Minor fixes and housekeeping (version bump to 1.3.1).

### Added

- **SSE Log Buffering**: In-memory event buffer with searchable historical retrieval (`get_recent_logs`, `get_historical_logs`).
- **Internal Health Metrics**: New `get_mcp_health` and `get_mcp_capabilities` for agent self-diagnostic.
- **Enhanced Reliability**: Axios connection pooling (Keep-Alive) and global 10s timeout.
- **Lazy Discovery**: Background pre-warming of items/things cache for zero-latency initial responses.

## [1.2.0] - 2026-03-12

### Added

- **Community-Inspired Enhancements**:
  - `trigger_discovery_scan`: Manual hardware scan triggering.
  - `get_semantic_path`: Full semantic breadcrumb navigation.
  - `find_neighboring_equipment`: Spatial awareness tool.
  - `schedule_command`: Future-dated command queuing.
  - `get_stale_items`: Proactive maintenance for sensors.
- Optimized for agentic queries with updated `get_prompt_context`.

## [1.1.0] - 2026-03-11

### Added

- Initial release of OpenHAB MCP server.
- Support for Items, Things, Rules, Persistence, and Semantic Tags.
- Real-time event streaming via SSE.
- Advanced tools for system auditing, simulation, and energy insights.
- ASCII sparkline charts and system health analysis.

### Changed

- Refactored tool registration for better categorization.
- Standardized naming conventions for tools.

### Fixed

- Duplicated documentation in README.
- Missing `get_system_summary` tool exposure.
