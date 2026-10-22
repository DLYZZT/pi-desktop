import { isDeepStrictEqual } from "node:util";
import type { AgentSessionLike } from "../shared/pi-types";
import type { SessionModelSelection } from "./session-model-selection";
import { getModelConfigRevision } from "./model-config-revision";

/** Refresh the selected model at an idle command boundary after models.json is saved. */
export class SessionModelConfig {
  private revision = -1;
  private pending?: Promise<void>;

  async sync(inner: AgentSessionLike, selection: SessionModelSelection): Promise<void> {
    const revision = getModelConfigRevision();
    if (this.revision === revision) return;
    if (this.pending) {
      await this.pending;
      return this.sync(inner, selection);
    }
    if (!inner.model || !inner.modelRuntime.refresh) {
      this.revision = revision;
      return;
    }
    if (inner.isStreaming || inner.isCompacting)
      throw new Error("Wait for the current turn before applying updated model settings");
    const current = inner.model;
    this.pending = (async () => {
      selection.assertReady(inner);
      await inner.modelRuntime.refresh!({ allowNetwork: false });
      selection.assertReady(inner);
      // An explicit model switch that completed while refreshing takes precedence.
      if (inner.model !== current) return;
      const provider = selection.resolveProvider(current.provider, current.id, inner.sessionManager);
      const model = inner.modelRuntime.getModel(provider, current.id);
      if (!model) throw new Error("The selected model is no longer configured. Select a model before continuing.");
      if (!isDeepStrictEqual(model, current)) {
        const thinking = inner.agent.state?.thinkingLevel;
        await inner.setModel(model);
        // Refreshing definitions must preserve the session's choice, subject to the new capabilities.
        if (thinking) inner.setThinkingLevel(thinking);
      }
      this.revision = revision;
    })();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
}
