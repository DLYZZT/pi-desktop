import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enUS, zhCN } from "./i18n-dictionaries.ts";

const owners = {
  session: readFileSync(new URL("./components/SessionSidebar.tsx", import.meta.url), "utf8"),
  models: readFileSync(new URL("./components/ModelsConfig.tsx", import.meta.url), "utf8"),
  channels: readFileSync(new URL("./components/channels/ChannelsConfig.tsx", import.meta.url), "utf8"),
  updates: readFileSync(new URL("./components/SettingsConfig.tsx", import.meta.url), "utf8"),
  skills: readFileSync(new URL("./components/SkillsConfig.tsx", import.meta.url), "utf8"),
};

const scenarios = [
  {
    key: "noSkillsFound",
    owner: "skills",
    en: "No skills found",
    zh: "未找到技能",
  },
  {
    key: "deleteSessionConfirm",
    owner: "session",
    en: "Delete “{title}”?",
    zh: "删除“{title}”？",
  },
  {
    key: "worktreeForceRemoveConfirm",
    owner: "session",
    en: "Uncommitted changes. Force remove checkout?",
    zh: "存在未提交的更改，是否强制移除 checkout？",
  },
  {
    key: "modelConfigConflict",
    owner: "models",
    en: "models.json changed outside this editor. Your edits are preserved here; copy or compare them before reloading the disk version to merge manually.",
    zh: "models.json 已在此编辑器之外被修改。你的编辑仍保留在此处；重新加载磁盘版本前，请先复制或比较这些内容并手动合并。",
  },
  {
    key: "activityOutcome_failed",
    owner: "channels",
    en: "failed",
    zh: "失败",
  },
  {
    key: "updateErrorOffline",
    owner: "updates",
    en: "Unable to reach the update service. Check your network and try again.",
    zh: "当前无法连接更新服务，请检查网络后重试。",
  },
];

test("critical empty, destructive, conflict, channel, and update UI is bilingual and consumed", () => {
  for (const scenario of scenarios) {
    assert.equal(enUS[scenario.key], scenario.en, `${scenario.key} en-US`);
    assert.equal(zhCN[scenario.key], scenario.zh, `${scenario.key} zh-CN`);
    assert.match(owners[scenario.owner], new RegExp(`t\\(\\s*"${scenario.key}"`), `${scenario.key} owner usage`);
  }
});
