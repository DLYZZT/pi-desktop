import assert from "node:assert/strict";
import test from "node:test";
import { selectDefaultCandidates } from "./public-state.ts";

test("PowerShell auto selection prefers 7, retains an explicit custom executable and falls back to Windows PowerShell", () => {
  const candidate = (executable, provider = "system") => ({
    capability: "shell.powershell",
    executable,
    provider,
    health: "healthy",
  });
  const inbox = candidate("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const pwsh = candidate("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  const custom = candidate("D:\\chosen\\powershell.exe", "custom");
  const select = (candidates, preference = "auto") =>
    selectDefaultCandidates(candidates, { "shell.powershell": preference })["shell.powershell"];
  assert.equal(select([inbox, pwsh]), pwsh);
  assert.equal(select([inbox]), inbox);
  assert.equal(select([inbox, pwsh, custom]), custom);
  assert.equal(select([inbox, pwsh, custom], "custom"), custom);
  assert.equal(select([inbox, { ...pwsh, health: "broken" }]), inbox);
});
