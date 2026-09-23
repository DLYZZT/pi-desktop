import type { HerdrAgentState, HerdrPane } from "@contract/herdr";

export function countHerdrAgents(panes: readonly HerdrPane[]): Record<HerdrAgentState, number> {
  const counts: Record<HerdrAgentState, number> = { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 };
  for (const pane of panes) {
    if (pane.agent) counts[pane.agent.state] += 1;
  }
  return counts;
}

export function herdrPaneMatchesFilter(pane: HerdrPane, filter: HerdrAgentState | "all"): boolean {
  return filter === "all" || pane.agent?.state === filter;
}
