import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatWindowSource = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

const noticeShelfStart = chatWindowSource.indexOf("function NoticeShelf(");
const noticeShelfEnd = chatWindowSource.indexOf("type ExtensionDialogRequest", noticeShelfStart);
assert.notEqual(noticeShelfStart, -1);
assert.notEqual(noticeShelfEnd, -1);
const noticeShelfSource = chatWindowSource.slice(noticeShelfStart, noticeShelfEnd);

const noticeItemClass = noticeShelfSource.indexOf('className="notice-shelf-item"');
const noticeItemStyleStart = noticeShelfSource.indexOf("style={{", noticeItemClass);
const noticeItemStyleEnd = noticeShelfSource.indexOf("}}", noticeItemStyleStart);
const noticeMessage = noticeShelfSource.indexOf("{notice.message}");
const noticeMessageStyleStart = noticeShelfSource.lastIndexOf("style={{", noticeMessage);
const noticeMessageStyleEnd = noticeShelfSource.indexOf("}}", noticeMessageStyleStart);
for (const position of [
  noticeItemClass,
  noticeItemStyleStart,
  noticeItemStyleEnd,
  noticeMessage,
  noticeMessageStyleStart,
  noticeMessageStyleEnd,
]) {
  assert.notEqual(position, -1);
}
const noticeItemStyle = noticeShelfSource.slice(noticeItemStyleStart, noticeItemStyleEnd);
const noticeMessageStyle = noticeShelfSource.slice(noticeMessageStyleStart, noticeMessageStyleEnd);

function keyframesSource(name, nextMarker) {
  const start = cssSource.indexOf(`@keyframes ${name}`);
  const end = cssSource.indexOf(nextMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return cssSource.slice(start, end);
}

test("multiline notices preserve explicit line breaks", () => {
  assert.match(noticeMessageStyle, /whiteSpace:\s*"pre-wrap"/);
  assert.doesNotMatch(noticeMessageStyle, /whiteSpace:\s*"nowrap"/);
});

test("long unbroken notice text wraps instead of being truncated", () => {
  assert.match(noticeMessageStyle, /overflowWrap:\s*"anywhere"/);
  assert.doesNotMatch(noticeMessageStyle, /textOverflow:\s*"ellipsis"/);
});

test("single-line notices keep their baseline height without capping taller content", () => {
  assert.match(noticeItemStyle, /minHeight:\s*60/);
  assert.doesNotMatch(noticeItemStyle, /(?:^|\n)\s*height:\s*60/);
  assert.doesNotMatch(noticeItemStyle, /maxHeight:\s*60/);
});

test("notice animations never restore a fixed height", () => {
  const animations = [
    keyframesSource("notice-shelf-in", "@keyframes notice-shelf-out"),
    keyframesSource("notice-shelf-out", "@media (prefers-reduced-motion: reduce)"),
  ];

  for (const animation of animations) {
    assert.doesNotMatch(animation, /(?:^|\n)\s*(?:height|min-height|max-height):/);
    assert.match(animation, /opacity:/);
    assert.match(animation, /transform:/);
  }
});
