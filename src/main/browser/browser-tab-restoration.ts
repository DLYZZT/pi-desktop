import type { BrowserRestoreTabRecord, BrowserTabInfo } from "../../contract/browser.ts";

export function toBrowserRestoreRecords(tabs: readonly BrowserTabInfo[]): BrowserRestoreTabRecord[] {
  return tabs
    .filter((tab) => !tab.advancedProfile)
    .map((tab, order) => ({ profileId: tab.profileId, url: tab.url, ownerSessionId: tab.ownerSessionId, order }));
}

export function countAdvancedProfileTabs(tabs: readonly BrowserTabInfo[]): number {
  return tabs.filter((tab) => tab.advancedProfile).length;
}
