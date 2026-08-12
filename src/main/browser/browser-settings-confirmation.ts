import type { BrowserSettingsPatch, BrowserSettingsV2 } from "../../contract/browser.ts";
import { applyBrowserSettingsPatch, validateBrowserSettingsPatch } from "./browser-settings.ts";

export interface PreparedBrowserSettingsUpdate {
  canonicalPatch: BrowserSettingsPatch;
  requiresAdvancedConfirmation: boolean;
}

export function prepareBrowserSettingsUpdate(
  current: BrowserSettingsV2,
  patchValue: unknown,
): PreparedBrowserSettingsUpdate {
  const canonicalPatch = validateBrowserSettingsPatch(patchValue);
  applyBrowserSettingsPatch(current, canonicalPatch);
  return {
    canonicalPatch,
    requiresAdvancedConfirmation:
      canonicalPatch.advancedBrowserMode?.enabled === true && !current.advancedBrowserMode.enabled,
  };
}

export function authorizeBrowserSettingsUpdate(
  current: BrowserSettingsV2,
  patchValue: unknown,
  authorize: (canonicalPatch: BrowserSettingsPatch) => void,
): BrowserSettingsPatch {
  const prepared = prepareBrowserSettingsUpdate(current, patchValue);
  if (prepared.requiresAdvancedConfirmation) authorize(prepared.canonicalPatch);
  return prepared.canonicalPatch;
}
