import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const dictionariesSource = readFileSync(new URL("../i18n-dictionaries.ts", import.meta.url), "utf8");
const chatWindowSource = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const messageViewSource = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("General settings exposes complete accessible chat appearance controls", () => {
  for (const id of ["chatFontSizeControlId", "chatLayoutControlId"]) assert.match(settingsSource, new RegExp(id));
  for (const value of ["small", "standard", "large", "extra-large", "fixed", "wide"]) {
    assert.match(settingsSource, new RegExp(`<option value="${value}">`));
  }
  assert.match(settingsSource, /chatLayoutFixed", "Comfortable width"/);
  assert.match(settingsSource, /chatLayoutWide", "Expanded width"/);
  assert.match(dictionariesSource, /chatLayoutFixed:\s*"舒适宽度"/);
  assert.match(dictionariesSource, /chatLayoutWide:\s*"扩展宽度"/);
  assert.match(settingsSource, /disabled=\{chatAppearanceSaving\}/);
  assert.match(settingsSource, /role="alert"[\s\S]*?chatAppearanceSaveFailed/);
  assert.match(settingsSource, /onChatAppearanceChange\(next\)/);
});

test("chat appearance CSS defines scoped font scales and both width modes", () => {
  assert.match(cssSource, /\.chat-appearance-scope\s*\{[\s\S]*?--chat-font-scale:\s*1/);
  assert.match(cssSource, /data-chat-font-size="small"[\s\S]*?--chat-font-scale:\s*0\.9/);
  assert.match(cssSource, /data-chat-font-size="large"[\s\S]*?--chat-font-scale:\s*1\.15/);
  assert.match(cssSource, /data-chat-font-size="extra-large"[\s\S]*?--chat-font-scale:\s*1\.3/);
  assert.match(cssSource, /data-chat-layout="wide"[\s\S]*?--chat-content-max-width:\s*clamp\(760px,\s*74%,\s*960px\)/);
  assert.doesNotMatch(cssSource, /data-chat-layout="full"|--chat-content-max-width:\s*100%/);
  assert.match(cssSource, /\.chat-content-column\s*\{[\s\S]*?max-width:\s*var\(--chat-content-max-width\)/);
  assert.doesNotMatch(cssSource, /var\(--chat-font-scale\)(?!\s*:)/);
});

test("the full-width dock applies the chat width once after reserving the minimap gutter", () => {
  assert.equal((chatWindowSource.match(/className="chat-content-column/g) ?? []).length, 4);
  assert.equal((chatInputSource.match(/className="chat-content-column"/g) ?? []).length, 1);
  assert.match(chatWindowSource, /className="chat-input-transition-dock[^\n]*w-full/);
  assert.doesNotMatch(chatWindowSource, /className="chat-content-column chat-input-transition-dock/);
  assert.match(
    chatWindowSource,
    /ref=\{scrollContainerRef\}[\s\S]*?paddingLeft:\s*CHAT_COLUMN_PADDING,[\s\S]*?paddingRight:\s*CHAT_COLUMN_PADDING/,
  );
  assert.match(chatWindowSource, /paddingRight:\s*isMobile \? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING/);
  assert.doesNotMatch(chatWindowSource, /maxWidth:\s*"var\(--chat-content-max-width\)"/);
  assert.doesNotMatch(chatInputSource, /maxWidth:\s*"var\(--chat-content-max-width\)"/);
});

test("chat text uses the shared scale while glyph-only icons remain fixed", () => {
  assert.match(chatWindowSource, /fontSize:\s*scaledChatFont\(22\)/);
  assert.match(chatInputSource, /fontSize:\s*scaledChatFont\(14\)/);
  assert.match(messageViewSource, /fontSize:\s*scaledChatFont\(13\.5\)/);
  assert.deepEqual(chatInputSource.match(/fontSize:\s*[0-9]+(?:\.[0-9]+)?/g) ?? [], []);
  assert.deepEqual(messageViewSource.match(/fontSize:\s*[0-9]+(?:\.[0-9]+)?/g) ?? [], ["fontSize: 10"]);
});
