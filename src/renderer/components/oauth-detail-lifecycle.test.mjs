import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const detail = source.slice(source.indexOf("function OAuthDetail("), source.indexOf("function ApiKeyDetail("));

test("OAuthDetail has one provider lifecycle effect and only its cleanup cancels the captured provider", () => {
  const lifecycleStart = detail.indexOf("// Reset state on entry/provider changes.");
  const loginStart = detail.indexOf("const handleLogin = useCallback");
  const lifecycle = detail.slice(lifecycleStart, loginStart);

  assert.notEqual(lifecycleStart, -1);
  assert.notEqual(loginStart, -1);
  assert.equal(lifecycle.match(/useEffect\(\(\) =>/g)?.length, 1);
  assert.match(lifecycle, /const providerId = provider\.id;/);
  assert.equal(lifecycle.match(/auth\.loginCancel/g)?.length, 1);
  assert.match(lifecycle, /return \(\) => \{[\s\S]*provider: providerId/);
  assert.doesNotMatch(lifecycle.slice(0, lifecycle.indexOf("return () =>")), /auth\.loginCancel/);
});

test("each explicit login attempt awaits one cancellation before creating its replacement stream", () => {
  const loginStart = detail.indexOf("const handleLogin = useCallback");
  const cancelStart = detail.indexOf("const handleCancelLogin = useCallback");
  const login = detail.slice(loginStart, cancelStart);

  assert.equal(login.match(/auth\.loginCancel/g)?.length, 1);
  assert.match(login, /await call\("auth\.loginCancel", \{ provider: provider\.id \}\);/);
  assert.ok(login.indexOf("auth.loginCancel") < login.indexOf("new EventSource"));
  assert.match(login, /if \(loginAttemptRef\.current !== attempt\) return;[\s\S]*new EventSource/);
});
