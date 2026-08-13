import assert from "node:assert/strict";
import test from "node:test";
import { formatCompactNumber, formatFileSize, formatNumber, formatRelativeDateTime } from "./locale-format.ts";

const now = new Date("2026-08-12T12:00:00.000Z");

test("formats relative time with the selected locale and fixed thresholds", () => {
  assert.equal(formatRelativeDateTime("2026-08-12T11:59:45.000Z", "en-US", now), "now");
  assert.equal(formatRelativeDateTime("2026-08-12T11:55:00.000Z", "en-US", now), "5 minutes ago");
  assert.equal(formatRelativeDateTime("2026-08-12T10:00:00.000Z", "zh-CN", now), "2小时前");
  assert.equal(formatRelativeDateTime("2026-08-10T12:00:00.000Z", "zh-CN", now), "前天");
  assert.equal(formatRelativeDateTime("invalid", "en-US", now), "");
});

test("formats numbers and file sizes with locale-aware separators", () => {
  assert.equal(formatNumber(1234567, "en-US"), "1,234,567");
  assert.equal(formatNumber(1234567, "zh-CN"), "1,234,567");
  assert.equal(formatCompactNumber(1200, "en-US"), "1.2K");
  assert.equal(formatCompactNumber(12000, "zh-CN"), "1.2万");
  assert.equal(formatFileSize(1536, "en-US"), "1.5 KB");
  assert.equal(formatFileSize(1024 * 1024, "zh-CN"), "1 MB");
  assert.equal(formatFileSize(-1, "en-US"), "");
});
