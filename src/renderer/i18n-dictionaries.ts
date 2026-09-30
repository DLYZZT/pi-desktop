import type { AppLanguage } from "../shared/app-language.ts";
import { mergeDictionaries } from "./i18n/merge-dictionaries.ts";
import { enUS as browserEnUS, zhCN as browserZhCN, zhTW as browserZhTW } from "./i18n/browser.ts";
import { enUS as channelsEnUS, zhCN as channelsZhCN, zhTW as channelsZhTW } from "./i18n/channels.ts";
import { enUS as commonEnUS, zhCN as commonZhCN, zhTW as commonZhTW } from "./i18n/common.ts";
import { enUS as composerEnUS, zhCN as composerZhCN, zhTW as composerZhTW } from "./i18n/composer.ts";
import { enUS as filesEnUS, zhCN as filesZhCN, zhTW as filesZhTW } from "./i18n/files.ts";
import { enUS as executionsEnUS, zhCN as executionsZhCN, zhTW as executionsZhTW } from "./i18n/executions.ts";
import { enUS as mcpEnUS, zhCN as mcpZhCN, zhTW as mcpZhTW } from "./i18n/mcp.ts";
import { enUS as herdrEnUS, zhCN as herdrZhCN, zhTW as herdrZhTW } from "./i18n/herdr.ts";
import { enUS as modelsEnUS, zhCN as modelsZhCN, zhTW as modelsZhTW } from "./i18n/models.ts";
import { enUS as resourcesEnUS, zhCN as resourcesZhCN, zhTW as resourcesZhTW } from "./i18n/resources.ts";
import { enUS as sessionEnUS, zhCN as sessionZhCN, zhTW as sessionZhTW } from "./i18n/session.ts";
import { enUS as settingsEnUS, zhCN as settingsZhCN, zhTW as settingsZhTW } from "./i18n/settings.ts";

export const enUS = mergeDictionaries(
  browserEnUS,
  channelsEnUS,
  commonEnUS,
  composerEnUS,
  filesEnUS,
  executionsEnUS,
  mcpEnUS,
  herdrEnUS,
  modelsEnUS,
  resourcesEnUS,
  sessionEnUS,
  settingsEnUS,
);
export const zhCN = mergeDictionaries(
  browserZhCN,
  channelsZhCN,
  commonZhCN,
  composerZhCN,
  filesZhCN,
  executionsZhCN,
  mcpZhCN,
  herdrZhCN,
  modelsZhCN,
  resourcesZhCN,
  sessionZhCN,
  settingsZhCN,
);
export const zhTW = mergeDictionaries(
  browserZhTW,
  channelsZhTW,
  commonZhTW,
  composerZhTW,
  filesZhTW,
  executionsZhTW,
  mcpZhTW,
  herdrZhTW,
  modelsZhTW,
  resourcesZhTW,
  sessionZhTW,
  settingsZhTW,
);

export const dictionaries = { "en-US": enUS, "zh-CN": zhCN, "zh-TW": zhTW } satisfies Record<
  AppLanguage,
  Record<string, string>
>;
