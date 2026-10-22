import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { ModelsConfigSelection, ProviderEntry } from "@/lib/models-config-state";

export function CustomProviderTree({
  providers,
  selection,
  onSelect,
  onAddModel,
}: {
  providers: [string, ProviderEntry][];
  selection: ModelsConfigSelection | null;
  onSelect: (selection: ModelsConfigSelection) => void;
  onAddModel: (provider: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (selection?.type === "model")
      setExpanded((current) =>
        current[selection.providerName] ? current : { ...current, [selection.providerName]: true },
      );
  }, [selection]);
  const search = query.trim().toLocaleLowerCase();
  const matches = providers.flatMap(([name, provider]) => {
    const providerMatches = name.toLocaleLowerCase().includes(search);
    const models = (provider.models ?? [])
      .map((model, index) => ({ model, index }))
      .filter(
        ({ model }) =>
          !search || providerMatches || (model.id + " " + (model.name ?? "")).toLocaleLowerCase().includes(search),
      );
    return !search || providerMatches || models.length ? [{ name, provider, models }] : [];
  });
  if (!providers.length) return null;
  return (
    <nav className="custom-model-tree" aria-label={t("modelCustomProviders", "Custom providers")}>
      <div className="custom-model-tree-search">
        <span>{t("modelCustomProviders", "Custom providers")}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("modelSearchCustom", "Search custom providers and models")}
          placeholder={t("modelSearchCustomPlaceholder", "Search provider or model…")}
        />
      </div>
      {matches.map(({ name, provider, models }) => {
        const open = Boolean(search) || Boolean(expanded[name]);
        const selected = selection?.type === "provider" && selection.name === name;
        return (
          <div key={name} className="custom-model-tree-group">
            <div className="custom-model-tree-provider" data-selected={selected}>
              <button
                type="button"
                className="custom-model-tree-toggle"
                aria-expanded={open}
                aria-label={(open
                  ? t("modelCollapseProvider", "Collapse models for {provider}")
                  : t("modelExpandProvider", "Expand models for {provider}")
                ).replace("{provider}", name)}
                disabled={Boolean(search)}
                onClick={() => setExpanded((current) => ({ ...current, [name]: !open }))}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                  style={{ transform: open ? "rotate(90deg)" : undefined }}
                >
                  <path d="m9 5 7 7-7 7" />
                </svg>
              </button>
              <button
                type="button"
                className="custom-model-tree-name"
                title={name}
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelect({ type: "provider", name })}
              >
                <span>{name}</span>
                <small>{provider.models?.length ?? 0}</small>
              </button>
            </div>
            {open && (
              <div className="custom-model-tree-models">
                {models.map(({ model, index }) => {
                  const active =
                    selection?.type === "model" && selection.providerName === name && selection.index === index;
                  const slash = model.id.lastIndexOf("/");
                  const label = model.name || model.id.slice(slash + 1) || t("modelNewModel", "new model");
                  const prefix = model.name ? model.id : slash >= 0 ? model.id.slice(0, slash) : "";
                  return (
                    <button
                      type="button"
                      key={index}
                      className="custom-model-tree-model"
                      data-selected={active}
                      aria-current={active ? "page" : undefined}
                      title={name + "/" + model.id}
                      aria-label={t("modelEditNamed", "Edit model {model}").replace("{model}", model.id || label)}
                      onClick={() => onSelect({ type: "model", providerName: name, index })}
                    >
                      <span>{label}</span>
                      {prefix && <small>{prefix}</small>}
                    </button>
                  );
                })}
                <button type="button" className="custom-model-tree-add" onClick={() => onAddModel(name)}>
                  {t("modelAddModelAction", "Add model")}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {!matches.length && <p className="custom-model-hint">{t("modelNoMatchingModels", "No matching models.")}</p>}
    </nav>
  );
}
