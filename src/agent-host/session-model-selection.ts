import type { InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelSelectionNotice } from "../contract/types";
import type { AgentSessionLike, ModelLike } from "../shared/pi-types";
import type { createDesktopAgentSessionServices } from "./desktop-session-services";
import { LEGACY_AZURE_PROVIDER } from "./azure-upgrade";
import { getBranchModelSelection } from "./branch-model-selection";

type Services = Awaited<ReturnType<typeof createDesktopAgentSessionServices>>;

/** A fallback is displayable, but cannot send a request until the user chooses a model. */
export class SessionModelSelection {
  private notice?: ModelSelectionNotice;
  private requested?: { provider: string; modelId: string };
  private trackBranch = false;
  private renamed = false;

  prepare(services: Services, manager: SessionManager) {
    this.trackBranch = true;
    const saved = getBranchModelSelection(manager.getBranch(), (provider, id) =>
      services.modelRuntime.getModel(provider, id),
    );
    const provider = services.settingsManager.getDefaultProvider(),
      modelId = services.settingsManager.getDefaultModel();
    this.requested = saved ?? (provider ? { provider, modelId: modelId ?? "" } : undefined);
    if (this.requested?.provider !== LEGACY_AZURE_PROVIDER) return;
    const model = services.modelRuntime.getModel("azure", this.requested.modelId);
    this.renamed =
      services.azureUpgrade.status !== "review" &&
      Boolean(model) &&
      !services.modelRuntime.getModel(LEGACY_AZURE_PROVIDER, this.requested.modelId) &&
      services.modelRuntime.hasConfiguredAuth("azure");
    this.notice = {
      requiresChoice: !this.renamed,
      reason: this.renamed ? "azure-renamed" : "azure-review",
      requested: this.requested,
    };
    return this.renamed ? model : undefined;
  }
  finish(inner: AgentSessionLike, fallbackMessage?: string): void {
    if (
      this.renamed &&
      inner.model?.provider === "azure" &&
      inner.model.id === this.requested?.modelId &&
      inner.sessionManager.buildSessionContext().model?.provider === LEGACY_AZURE_PROVIDER
    )
      inner.sessionManager.appendModelChange("azure", inner.model.id);
    if (
      fallbackMessage ||
      (!this.renamed &&
        this.requested &&
        inner.model &&
        (inner.model.provider !== this.requested.provider ||
          (this.requested.modelId && inner.model.id !== this.requested.modelId)))
    )
      this.notice = {
        requiresChoice: true,
        reason: this.requested?.provider === LEGACY_AZURE_PROVIDER ? "azure-review" : "restore-fallback",
        requested: this.requested,
      };
    this.snapshot(inner);
  }
  snapshot(inner: AgentSessionLike): ModelSelectionNotice | undefined {
    const model = inner.model;
    if (this.trackBranch) {
      const saved = getBranchModelSelection(inner.sessionManager.getBranch(), (provider, id) =>
        inner.modelRuntime.getModel(provider, id),
      );
      if (
        saved?.provider === LEGACY_AZURE_PROVIDER &&
        model?.provider !== LEGACY_AZURE_PROVIDER &&
        !(model?.provider === "azure" && model.id === saved.modelId)
      )
        this.notice = { requiresChoice: true, reason: "azure-review", requested: saved };
    }
    if (!this.notice) return;
    if (this.notice.reason === "azure-renamed" && (model?.provider !== "azure" || model.id !== this.requested?.modelId))
      this.notice = { ...this.notice, requiresChoice: true, reason: "restore-fallback" };
    return { ...this.notice, actual: model ? { provider: model.provider, modelId: model.id } : undefined };
  }
  assertReady(inner: AgentSessionLike): void {
    const notice = this.snapshot(inner);
    if (!notice?.requiresChoice) return;
    const saved = notice.requested ? `${notice.requested.provider}/${notice.requested.modelId}` : "the saved model";
    const azureHint =
      notice.requested?.provider === LEGACY_AZURE_PROVIDER
        ? " Azure's provider ID is now azure; its Responses API ID remains azure-openai-responses."
        : "";
    throw new Error(
      `MODEL_SELECTION_REQUIRED: Could not safely restore ${saved}. Select a model explicitly before sending.${azureHint}`,
    );
  }
  selected(_model: ModelLike): void {
    this.notice = undefined;
    this.requested = undefined;
    this.renamed = false;
  }
  extension(): InlineExtension {
    return {
      name: "pi-desktop-model-selection",
      hidden: true,
      factory: (pi) => {
        pi.on("cache_warming_decision", () => (this.notice?.requiresChoice ? { action: "stop" } : undefined));
      },
    };
  }
}
