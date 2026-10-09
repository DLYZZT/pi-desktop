export interface ModelReference {
  provider: string;
  modelId: string;
}

export interface AutoRoutingConfig {
  enabled: boolean;
  strategy: "thinking" | "classifier";
  fast?: ModelReference;
  strong?: ModelReference;
  classifier?: ModelReference;
  fastThinking: string;
  strongThinking: string;
  retryFallback: boolean;
}

export interface AdvancedModelSettings {
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
    modelOverrides?: Record<string, { reserveTokens?: number; keepRecentTokens?: number }>;
  };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxAgentDelayMs?: number;
    provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
  };
  transport?: "auto" | "sse" | "websocket" | "websocket-cached";
}

export interface ModelSettingsSnapshot<T> {
  config: T;
  version: string;
}

export interface CatalogModel extends ModelReference {
  name: string;
  type: "chat" | "classifier" | "image";
  virtual: boolean;
  available: boolean;
  thinkingLevels: string[];
}

export const AUTO_ROUTING_PROVIDER = "pi-desktop-router";
export const AUTO_ROUTING_MODEL = "auto";
