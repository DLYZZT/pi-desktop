import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./api-client.ts", import.meta.url), "utf8");

test("renderer API client exposes session relocation", () => {
  assert.match(source, /export async function relocateSession\(id: string, cwd: string\)/);
  assert.match(source, /return call\("sessions\.relocate", \{ id, cwd \}\)/);
});
