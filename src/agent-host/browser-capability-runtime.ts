import type { BrowserCapabilitySnapshot, BrowserPermissionLevel } from "../contract/browser";

const RANK: Record<BrowserPermissionLevel, number> = { none: 0, read: 1, interact: 2, advanced: 3 };

const disabledSnapshot = (): BrowserCapabilitySnapshot => ({
  revision: 0,
  browserEnabled: false,
  automationEnabled: false,
  advancedEnabled: false,
  sessionPermissions: {},
  generatedAt: 0,
});

class BrowserCapabilityRuntime {
  private snapshot = disabledSnapshot();

  apply(value: BrowserCapabilitySnapshot): void {
    if (
      !value ||
      !Number.isSafeInteger(value.revision) ||
      typeof value.browserEnabled !== "boolean" ||
      typeof value.automationEnabled !== "boolean" ||
      !value.sessionPermissions ||
      typeof value.sessionPermissions !== "object"
    ) {
      throw new Error("Invalid Browser capability snapshot");
    }
    this.snapshot = structuredClone(value);
  }

  getSnapshot(): BrowserCapabilitySnapshot {
    return structuredClone(this.snapshot);
  }

  permissionFor(sessionId: string): BrowserPermissionLevel {
    if (!this.snapshot.browserEnabled || !this.snapshot.automationEnabled) return "none";
    const permission = this.snapshot.sessionPermissions[sessionId] ?? "none";
    if (permission === "advanced" && !this.snapshot.advancedEnabled) return "interact";
    return permission;
  }

  allows(sessionId: string, required: BrowserPermissionLevel): boolean {
    return RANK[this.permissionFor(sessionId)] >= RANK[required];
  }
}

export const browserCapabilityRuntime = new BrowserCapabilityRuntime();
