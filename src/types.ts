/**
 * Core OpenHAB Item interface
 */
export interface OpenHabItem {
  name: string;
  label?: string;
  type: string;
  state: string;
  category?: string;
  tags: string[];
  groupNames: string[];
  metadata?: Record<string, unknown>;
  /** false for file-managed items that cannot be changed via REST API */
  editable?: boolean;
}

/**
 * A single issue found by auditSemanticModel.
 * safeFix is null when the issue requires manual intervention (e.g. non-editable item,
 * broken reference where the replacement parent must be chosen by the user).
 */
export interface SemanticIssue {
  item: string;
  label?: string;
  type: string;
  semanticClass: string;
  currentGroups: string[];
  editable: boolean;
  issue:
    | 'equipment_no_location'
    | 'point_no_parent'
    | 'broken_reference'
    | 'conflicting_class'
    | 'not_editable';
  description: string;
  brokenRefKey?: string;
  brokenRefValue?: string;
  safeFix: {
    action: 'set_semantic_parent';
    key: 'hasLocation' | 'isPartOf' | 'isPointOf';
    suggestedParents: string[];
  } | null;
}

/**
 * Core OpenHAB Thing interface
 */
export interface OpenHabThing {
  UID: string;
  label: string;
  thingTypeUID: string;
  statusInfo: {
    status: string;
    statusDetail: string;
  };
  configuration: Record<string, unknown>;
  channels: unknown[];
}

/**
 * Core OpenHAB Rule interface
 */
export interface OpenHabRule {
  uid: string;
  name: string;
  enabled: boolean;
  tags: string[];
  triggers: unknown[];
  conditions: unknown[];
  actions: unknown[];
}

/**
 * OpenHAB Link between Item and Channel
 */
export interface OpenHabLink {
  itemName: string;
  channelUID: string;
  configuration?: Record<string, unknown>;
}

/**
 * Semantic Tag definition
 */
export interface OpenHabSemanticTag {
  id: string;
  label: string;
  description?: string;
}

/**
 * Persistence data for an item
 */
export interface OpenHabPersistenceData {
  name: string;
  datapoints: number;
  data: Array<{
    time: number;
    state: string;
  }>;
}

/**
 * Logger information
 */
export interface OpenHabLogger {
  loggerName: string;
  level: string;
}

/**
 * Discovery Inbox item
 */
export interface OpenHabInboxItem {
  thingUID: string;
  label: string;
  flag: string;
}

/**
 * Addon information
 */
export interface OpenHabAddon {
  id: string;
  label: string;
  version: string;
  installed: boolean;
}

/**
 * Sitemap definition
 */
export interface OpenHabSitemap {
  name: string;
  label: string;
  link: string;
  homepage: {
    link: string;
    leaf: boolean;
  };
}

/**
 * Service information
 */
export interface OpenHabService {
  id: string;
  label: string;
  category: string;
}

/**
 * Service configuration
 */
export type OpenHabServiceConfig = Record<string, unknown>;

/**
 * UI Template definition
 */
export interface OpenHabTemplate {
  uid: string;
  label: string;
}

/**
 * Transformation definition
 */
export interface OpenHabTransformation {
  uid: string;
  type: string;
  label: string;
}
