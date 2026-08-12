import assert from "node:assert/strict";
import test from "node:test";
import { countAdvancedProfileTabs, toBrowserRestoreRecords } from "./browser-tab-restoration.ts";

function tab(id, { advanced = false, advancedProfile = false } = {}) {
  return {
    id,
    ownerSessionId: `session-${id}`,
    profileId: `profile-${id}`,
    url: `https://${id}.example.test/`,
    title: id,
    generation: 0,
    visible: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    control: "user",
    advanced,
    advancedProfile,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

test("restores normal Profiles even after or during an advanced Agent action", () => {
  const records = toBrowserRestoreRecords([
    tab("normal"),
    tab("advanced-action", { advanced: true }),
    tab("unsafe-profile", { advancedProfile: true }),
  ]);

  assert.deepEqual(
    records.map(({ profileId, order }) => ({ profileId, order })),
    [
      { profileId: "profile-normal", order: 0 },
      { profileId: "profile-advanced-action", order: 1 },
    ],
  );
  assert.equal(countAdvancedProfileTabs([tab("normal"), tab("unsafe", { advancedProfile: true })]), 1);
});
