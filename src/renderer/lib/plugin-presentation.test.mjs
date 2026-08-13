import assert from "node:assert/strict";
import test from "node:test";
import { enUS, zhCN } from "../i18n-dictionaries.ts";
import { pluginResourceSummary, pluginStatusLabel, pluginVersionSummary } from "./plugin-presentation.ts";

const translate = (dictionary) => (key, fallback) => dictionary[key] ?? fallback;
const basePackage = {
  source: "npm:test",
  scope: "global",
  filtered: false,
  disabled: false,
  counts: { extensions: 1200, skills: 2, prompts: 0, themes: 1 },
  resources: [],
  status: "loaded",
};

test("formats plugin resource counts with the selected locale", () => {
  assert.equal(pluginResourceSummary(basePackage, "en-US", translate(enUS)), "1,200 ext · 2 skills · 1 themes");
  assert.equal(pluginResourceSummary(basePackage, "zh-CN", translate(zhCN)), "1,200 个扩展 · 2 个技能 · 1 个主题");
  assert.equal(
    pluginResourceSummary(
      { ...basePackage, counts: { extensions: 0, skills: 0, prompts: 0, themes: 0 } },
      "zh-CN",
      translate(zhCN),
    ),
    "无资源",
  );
});

test("localizes plugin status and version summaries", () => {
  assert.deepEqual(
    ["loaded", "installed", "disabled", "missing"].map((status) => pluginStatusLabel(status, translate(zhCN))),
    ["已加载", "已安装", "已禁用", "缺失"],
  );
  assert.equal(
    pluginVersionSummary({ ...basePackage, version: "1.2.3", configuredVersion: "^1.0.0" }, translate(zhCN)),
    "已安装 1.2.3 · 配置版本 ^1.0.0",
  );
});
