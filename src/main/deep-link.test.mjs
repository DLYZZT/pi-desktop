import assert from "node:assert/strict";
import test from "node:test";
import { findDesktopDeepLink, parseDesktopDeepLink } from "./deep-link.ts";

test("parses desktop session links with case-insensitive schemes", () => {
  assert.deepEqual(parseDesktopDeepLink("pi-agent-desktop://session/session-one"), { sessionId: "session-one" });
  assert.deepEqual(parseDesktopDeepLink("PI-AGENT-DESKTOP://SESSION/session-two"), { sessionId: "session-two" });
  assert.deepEqual(parseDesktopDeepLink("pi-agent-desktop:///session/session-three"), {
    sessionId: "session-three",
  });
});

test("finds only a valid desktop deep link in second-instance argv", () => {
  assert.equal(
    findDesktopDeepLink(["pi-desktop", "--flag", "PI-AGENT-DESKTOP://SESSION/windows-session"]),
    "PI-AGENT-DESKTOP://SESSION/windows-session",
  );
  assert.equal(
    findDesktopDeepLink(["pi-desktop", "https://example.test/session/secret", "pi-agent-desktop://bad"]),
    undefined,
  );
  assert.equal(parseDesktopDeepLink("pi-agent-desktop://session"), null);
});
