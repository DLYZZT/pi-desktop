import type { BrowserHeaderRule, BrowserHeaderRuleDirection } from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const MAX_AGENT_RULES_PER_SCOPE = 100;

type Entry = {
  profileId: string;
  direction: BrowserHeaderRuleDirection;
  sessionId: string;
  rules: BrowserHeaderRule[];
};

export type ChangedHeaderRuleScope = {
  profileId: string;
  direction: BrowserHeaderRuleDirection;
};

export type RemovedAgentHeaderRules = {
  rules: BrowserHeaderRule[];
  scopes: ChangedHeaderRuleScope[];
};

export class BrowserAgentHeaderRuleRegistry {
  private readonly entries = new Map<string, Entry>();

  get(profileId: string, direction: BrowserHeaderRuleDirection): BrowserHeaderRule[] {
    return [...this.entries.values()]
      .filter((entry) => entry.profileId === profileId && entry.direction === direction)
      .flatMap((entry) => entry.rules)
      .map((rule) => structuredClone(rule));
  }

  set(
    profileId: string,
    direction: BrowserHeaderRuleDirection,
    sessionId: string,
    rules: readonly BrowserHeaderRule[],
  ): BrowserHeaderRule[] {
    const key = entryKey(profileId, direction, sessionId);
    const previous = this.entries.get(key)?.rules ?? [];
    const otherRuleCount = [...this.entries.entries()].reduce(
      (count, [candidateKey, entry]) =>
        candidateKey !== key && entry.profileId === profileId && entry.direction === direction
          ? count + entry.rules.length
          : count,
      0,
    );
    if (otherRuleCount + rules.length > MAX_AGENT_RULES_PER_SCOPE) {
      throw new BrowserError(
        "INVALID_BROWSER_REQUEST",
        `Browser Agent header rules exceed the ${MAX_AGENT_RULES_PER_SCOPE} rule scope limit`,
      );
    }

    if (rules.length === 0) {
      this.entries.delete(key);
    } else {
      this.entries.set(key, {
        profileId,
        direction,
        sessionId,
        rules: rules.map((rule) => ({
          ...structuredClone(rule),
          source: "agent",
          ownerSessionId: sessionId,
        })),
      });
    }
    return previous.map((rule) => structuredClone(rule));
  }

  clearSession(sessionId: string): RemovedAgentHeaderRules {
    return this.removeWhere((entry) => entry.sessionId === sessionId);
  }

  clearProfile(profileId: string): RemovedAgentHeaderRules {
    return this.removeWhere((entry) => entry.profileId === profileId);
  }

  clear(): RemovedAgentHeaderRules {
    return this.removeWhere(() => true);
  }

  hasSecretRef(secretRef: string): boolean {
    return [...this.entries.values()].some((entry) => entry.rules.some((rule) => rule.secretRef === secretRef));
  }

  private removeWhere(predicate: (entry: Entry) => boolean): RemovedAgentHeaderRules {
    const rules: BrowserHeaderRule[] = [];
    const scopes = new Map<string, ChangedHeaderRuleScope>();
    for (const [key, entry] of this.entries) {
      if (!predicate(entry)) continue;
      this.entries.delete(key);
      rules.push(...entry.rules.map((rule) => structuredClone(rule)));
      scopes.set(scopeKey(entry.profileId, entry.direction), {
        profileId: entry.profileId,
        direction: entry.direction,
      });
    }
    return { rules, scopes: [...scopes.values()] };
  }
}

function entryKey(profileId: string, direction: BrowserHeaderRuleDirection, sessionId: string): string {
  return JSON.stringify([profileId, direction, sessionId]);
}

function scopeKey(profileId: string, direction: BrowserHeaderRuleDirection): string {
  return `${direction}\0${profileId}`;
}
