import assert from "node:assert/strict";
import test from "node:test";

import { readSessionArchived } from "../../shared/session-archive.ts";
import {
  filterSessionsForSidebar,
  groupSessionsByProject,
  projectFoldersForSidebar,
  sessionProjectLabel,
} from "./sessions.ts";

function session(id, overrides = {}) {
  return {
    id,
    name: "",
    firstMessage: "",
    cwd: "/workspace/pi-desktop",
    modified: "2026-07-15T12:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
}

test("sidebar list defaults to every live session and can filter by project", () => {
  const skills = session("skills", { projectRoot: "F:/Project/claude/skills", cwd: "F:/Project/claude/skills" });
  const desk = session("desk", { projectRoot: "F:/Project/dlyzzt-pi-desktop", cwd: "F:/Project/dlyzzt-pi-desktop" });
  const archived = session("old", {
    projectRoot: "F:/Project/claude/skills",
    cwd: "F:/Project/claude/skills",
    archived: true,
  });

  assert.deepEqual(
    filterSessionsForSidebar([skills, desk, archived], { archived: false }).map((item) => item.id),
    ["skills", "desk"],
  );
  assert.deepEqual(
    filterSessionsForSidebar([skills, desk, archived], {
      archived: false,
      projectRoot: "F:/Project/claude/skills",
    }).map((item) => item.id),
    ["skills"],
  );
  assert.deepEqual(
    filterSessionsForSidebar([skills, desk, archived], { archived: true }).map((item) => item.id),
    ["old"],
  );
  assert.equal(sessionProjectLabel(skills), "skills");
});

test("sidebar keeps archive-only folders until the user is searching", () => {
  const live = session("live", { projectRoot: "F:/Project/a", cwd: "F:/Project/a" });
  const archivedOnly = session("old-b", {
    projectRoot: "F:/Project/b",
    cwd: "F:/Project/b",
    archived: true,
    firstMessage: "nurture wait",
  });
  const folders = projectFoldersForSidebar([live, archivedOnly]);
  assert.deepEqual(
    folders.map((folder) => [folder.label, folder.sessions.map((item) => item.id), folder.archivedCount]),
    [
      ["a", ["live"], 0],
      ["b", [], 1],
    ],
  );
  assert.deepEqual(
    projectFoldersForSidebar([live, archivedOnly], "nurture").map((folder) => folder.label),
    [],
  );
});

test("archive-only project folders still exist when grouping all sessions", () => {
  const live = session("live", {
    projectRoot: "F:/Project/a",
    cwd: "F:/Project/a",
  });
  const archivedOnly = session("old", {
    projectRoot: "F:/Project/b",
    cwd: "F:/Project/b",
    archived: true,
    modified: "2026-07-16T00:00:00.000Z",
  });
  const folders = groupSessionsByProject([live, archivedOnly]);
  assert.deepEqual(
    folders.map((folder) => [folder.label, folder.sessions.map((item) => item.id)]),
    [
      ["b", ["old"]],
      ["a", ["live"]],
    ],
  );
});

test("groups live sessions into project folders by latest activity", () => {
  const older = session("older", {
    projectRoot: "F:/Project/a",
    cwd: "F:/Project/a",
    modified: "2026-07-01T00:00:00.000Z",
  });
  const newer = session("newer", {
    projectRoot: "F:/Project/b",
    cwd: "F:/Project/b",
    modified: "2026-07-15T00:00:00.000Z",
  });
  const sibling = session("sibling", {
    projectRoot: "F:/Project/a",
    cwd: "F:/Project/a",
    modified: "2026-07-02T00:00:00.000Z",
  });
  assert.deepEqual(
    groupSessionsByProject([older, newer, sibling]).map((folder) => [
      folder.label,
      folder.sessions.map((item) => item.id),
    ]),
    [
      ["b", ["newer"]],
      ["a", ["older", "sibling"]],
    ],
  );
});

test("archive flag follows the last desktop.archived custom entry", () => {
  assert.equal(readSessionArchived([]), false);
  assert.equal(
    readSessionArchived([
      { type: "custom", customType: "desktop.archived", data: { archived: true } },
      { type: "custom", customType: "desktop.archived", data: { archived: false } },
    ]),
    false,
  );
  assert.equal(
    readSessionArchived([{ type: "custom", customType: "desktop.archived", data: { archived: true } }]),
    true,
  );
});
