// Launch an isolated, no-model manual acceptance fixture from any checkout.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import electron from "electron";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = mkdtempSync(join(tmpdir(), "pi-custom-ui-smoke-"));
const agent = join(profile, "agent");
mkdirSync(agent);
writeFileSync(
  join(agent, "settings.json"),
  JSON.stringify({
    extensions: [join(root, "scripts/fixtures/desktop-ui-smoke.ts")],
    packages: [],
  }),
);
console.log(`Isolated profile: ${profile}\nOpen a session and run /desktop-ui-smoke. No model call is needed.`);
const child = spawn(electron, [`--user-data-dir=${join(profile, "desktop")}`, root], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions") },
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
