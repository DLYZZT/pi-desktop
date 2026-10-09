import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelCatalogStatus, ModelsListResult } from "@contract/types";
import { listModels, cancelModelsRefresh, refreshModels as requestModelsRefresh } from "@/lib/api-client";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import { useI18n } from "@/i18n";
import type { NoticeType } from "@/lib/notice-queue";

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string; virtual?: boolean };

export interface SessionModelsOptions {
  isNew: boolean;
  cwd?: string | null;
  refreshKey?: number;
  addNotice: (notice: { message: string; type?: NoticeType }) => void;
}

/** Owns the model catalog, user selection and request lifetimes for one session view. */
export function useSessionModels({ isNew, cwd, refreshKey, addNotice }: SessionModelsOptions) {
  const { t } = useI18n();
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogStatus>({
    source: "cache",
    refreshed: false,
    aborted: false,
    warnings: [],
  });
  const [modelRefreshing, setModelRefreshing] = useState(false);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>(
    {},
  );
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const modelRefreshRequestRef = useRef<string | null>(null);
  const modelListRequestGateRef = useRef(new LatestRequestGate());
  const modelListSizeRef = useRef(0);
  const applyModelsResult = useCallback(
    (d: ModelsListResult) => {
      const nextList: ModelEntry[] = d.models ?? [];
      const nameMap = d.nameMap ?? {};
      setModelNames(
        Object.keys(nameMap).length > 0
          ? nameMap
          : Object.fromEntries(nextList.map((m) => [`${m.provider}:${m.id}`, m.name])),
      );
      setModelThinkingLevels(d.thinkingLevels ?? {});
      setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
      modelListSizeRef.current = nextList.length;
      setModelList(nextList);
      setModelCatalog(d.catalog);
      if (isNew) {
        const match = d.defaultModel
          ? nextList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
          : undefined;
        const displayModel = match ?? (d.defaultModel ? undefined : nextList[0]);
        setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      }
    },
    [isNew],
  );

  const loadModels = useCallback(
    async (signal?: AbortSignal) => {
      if (signal?.aborted) return;
      const generation = modelListRequestGateRef.current.begin();
      const activeRefreshRequestId = modelRefreshRequestRef.current;
      if (activeRefreshRequestId) {
        modelRefreshRequestRef.current = null;
        setModelRefreshing(false);
        void cancelModelsRefresh(activeRefreshRequestId).catch(() => {});
      }
      const modelCwd = cwd ?? "";
      try {
        const d = await listModels(modelCwd || undefined);
        if (signal?.aborted || !modelListRequestGateRef.current.isCurrent(generation)) return;
        applyModelsResult(d);
      } catch (error) {
        if (!signal?.aborted && modelListRequestGateRef.current.isCurrent(generation)) throw error;
      }
    },
    [applyModelsResult, cwd],
  );

  const cancelModelRefresh = useCallback(() => {
    const requestId = modelRefreshRequestRef.current;
    if (!requestId) return;
    modelRefreshRequestRef.current = null;
    modelListRequestGateRef.current.invalidate();
    setModelRefreshing(false);
    void cancelModelsRefresh(requestId).catch(() => {});
  }, []);

  const refreshModels = useCallback(async () => {
    const previousRequestId = modelRefreshRequestRef.current;
    if (previousRequestId) void cancelModelsRefresh(previousRequestId).catch(() => {});
    const requestId = `models_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const generation = modelListRequestGateRef.current.begin();
    modelRefreshRequestRef.current = requestId;
    setModelRefreshing(true);
    const modelCwd = cwd ?? "";
    try {
      const result = await requestModelsRefresh(modelCwd || undefined, requestId);
      if (modelRefreshRequestRef.current !== requestId || !modelListRequestGateRef.current.isCurrent(generation))
        return;
      applyModelsResult(result);
    } catch {
      if (modelRefreshRequestRef.current !== requestId || !modelListRequestGateRef.current.isCurrent(generation))
        return;
      addNotice({
        type: "error",
        message: t(
          "modelDirectoryRefreshFailed",
          "Unable to refresh the model directory. Cached models remain available.",
        ),
      });
    } finally {
      if (modelRefreshRequestRef.current === requestId) {
        modelRefreshRequestRef.current = null;
        setModelRefreshing(false);
      }
    }
  }, [addNotice, applyModelsResult, cwd, t]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      console.error("Failed to load model directory:", e);
      addNotice({
        type: "warning",
        message:
          modelListSizeRef.current > 0
            ? t(
                "modelDirectoryLoadFailedCached",
                "Unable to load the model directory. Cached models remain available; retry from the model picker.",
              )
            : t(
                "modelDirectoryLoadFailed",
                "Unable to load the model directory. Retry from the model picker or check the Agent Host connection.",
              ),
      });
    });
    return () => controller.abort();
  }, [addNotice, loadModels, refreshKey, t]);

  useEffect(
    () => () => {
      cancelModelRefresh();
      // Also discard uncancellable catalog reads started by a command such as /reload.
      modelListRequestGateRef.current.invalidate();
    },
    [cancelModelRefresh, cwd],
  );

  return {
    modelNames,
    modelList,
    modelCatalog,
    modelRefreshing,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    newSessionModel,
    newSessionDefaultModel,
    setNewSessionModel,
    loadModels,
    refreshModels,
    cancelModelRefresh,
  };
}
