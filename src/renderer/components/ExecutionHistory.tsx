import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionPayload, ToolExecutionRecord } from "@contract/executions";
import { call, subscribe } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import { buildExecutionTree, type ExecutionTreeNode } from "@/lib/execution-tree";
import { LatestRequestGate } from "@/lib/latest-request-gate";

interface Props {
  sessionId: string | null;
  leafId?: string | null;
  revision?: string;
}

export function ExecutionHistory({ sessionId, leafId, revision }: Props) {
  const { t } = useI18n();
  const [records, setRecords] = useState<ToolExecutionRecord[]>([]);
  const [next, setNext] = useState<number>();
  const [complete, setComplete] = useState(true);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const generation = useRef(new LatestRequestGate()).current,
    refresh = useRef<() => void>(() => {});
  const read = useCallback(
    async (beforeSequence?: number) => {
      if (!sessionId) return;
      const request = generation.begin();
      setLoading(true);
      try {
        const page = await call("sessions.executions", {
          id: sessionId,
          leafId: leafId ?? undefined,
          limit: 100,
          beforeSequence,
        });
        if (!generation.isCurrent(request)) return;
        setRecords((current) => (beforeSequence ? [...current, ...page.records] : page.records));
        setNext(page.nextBeforeSequence);
        setComplete(page.complete);
        setError(false);
      } catch (error) {
        if (generation.isCurrent(request)) setError((error as { code?: string })?.code !== "NOT_FOUND");
      } finally {
        if (generation.isCurrent(request)) setLoading(false);
      }
    },
    [sessionId, leafId, generation],
  );
  useEffect(() => {
    setRecords([]);
    setNext(undefined);
    setError(false);
    setComplete(true);
    if (!sessionId) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const subscriptions: (() => void)[] = [];
    const reload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!disposed) void read();
      }, 100);
    };
    refresh.current = reload;
    void read();
    for (const promise of [
      subscribe("agent.events", sessionId, (event) => {
        if (
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_end" ||
          event.type === "prompt_done"
        )
          reload();
      }),
      subscribe("sessions.changed", sessionId, reload),
    ])
      void promise
        .then((off) => {
          if (disposed) off();
          else subscriptions.push(off);
        })
        .catch(() => {
          if (!disposed) setError(true);
        });
    return () => {
      disposed = true;
      generation.invalidate();
      if (timer) clearTimeout(timer);
      subscriptions.forEach((off) => off());
      refresh.current = () => {};
    };
  }, [sessionId, leafId, read, generation]);
  useEffect(() => {
    refresh.current();
  }, [revision]);
  if (!sessionId || (!records.length && !error && complete)) return null;
  const tree = buildExecutionTree(records);
  return (
    <details className="execution-history" data-execution-history>
      <summary>
        {t("executionHistory", "Tool execution history")} · {records.length}
      </summary>
      {!complete && (
        <p role="status">{t("executionHistoryIncomplete", "Some history could not be read completely.")}</p>
      )}
      {error && (
        <p role="alert">
          {t("executionHistoryFailed", "Could not read execution history.")}{" "}
          <button onClick={() => void read()}>{t("executionRetry", "Retry")}</button>
        </p>
      )}
      <ul>
        {tree.map((node) => (
          <ExecutionNode key={node.record.executionId} node={node} sessionId={sessionId} leafId={leafId} />
        ))}
      </ul>
      {next !== undefined && records.length < 1000 && (
        <button disabled={loading} onClick={() => void read(next)}>
          {t("executionLoadMore", "Load earlier calls")}
        </button>
      )}
      {next !== undefined && records.length >= 1000 && (
        <p>
          {t("executionHistoryBudget", "Showing the most recent 1,000 calls. The full history is retained on disk.")}
        </p>
      )}
    </details>
  );
}

export function ExecutionNode({
  node,
  sessionId,
  leafId,
  depth = 0,
}: {
  node: ExecutionTreeNode;
  sessionId: string;
  leafId?: string | null;
  depth?: number;
}) {
  const { t } = useI18n(),
    record = node.record;
  const statusLabels = {
    requested: t("executionStatus_requested", "Requested"),
    running: t("executionStatus_running", "Running"),
    succeeded: t("executionStatus_succeeded", "Succeeded"),
    failed: t("executionStatus_failed", "Failed"),
    blocked: t("executionStatus_blocked", "Blocked"),
    cancelled: t("executionStatus_cancelled", "Cancelled"),
    interrupted: t("executionStatus_interrupted", "Interrupted"),
  };
  return (
    <li data-execution-id={record.executionId} data-execution-status={record.status}>
      <details>
        <summary>
          <code>{record.toolName}</code> · {statusLabels[record.status]}
          {record.durationMs !== undefined && <span> · {record.durationMs} ms</span>}
        </summary>
        <div className="execution-detail">
          {record.outcomeUnknown && (
            <p role="status">
              {t("executionOutcomeUnknown", "The tool was interrupted; its actual outcome is unknown.")}
            </p>
          )}
          {record.error && <pre>{record.error}</pre>}
          {record.resourceRefs && (
            <p>
              {t("executionResourceObservation", "Resource IDs from a past observation")} ·{" "}
              {new Date(
                record.resourceObservation?.observedAt ?? record.endedAt ?? record.requestedAt,
              ).toLocaleString()}
              <br />
              {Object.entries(record.resourceRefs).map(([name, id]) => (
                <code key={name}>
                  {name}: {id}{" "}
                </code>
              ))}
            </p>
          )}
          {record.resourceRefs?.processId && <ProcessObservation processId={record.resourceRefs.processId} />}
          {record.arguments && (
            <OriginalPayload
              sessionId={sessionId}
              leafId={leafId}
              record={record}
              field="arguments"
              payload={record.arguments}
            />
          )}
          {record.result && (
            <OriginalPayload
              sessionId={sessionId}
              leafId={leafId}
              record={record}
              field="result"
              payload={record.result}
            />
          )}
        </div>
      </details>
      {!!node.children.length && depth < 32 && (
        <ul>
          {node.children.map((child) => (
            <ExecutionNode
              key={child.record.executionId}
              node={child}
              sessionId={sessionId}
              leafId={leafId}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function OriginalPayload({
  sessionId,
  leafId,
  record,
  field,
  payload,
}: {
  sessionId: string;
  leafId?: string | null;
  record: ToolExecutionRecord;
  field: "arguments" | "result";
  payload: ExecutionPayload;
}) {
  const { t } = useI18n();
  const [text, setText] = useState<string>(),
    [offset, setOffset] = useState<number>(),
    [positions, setPositions] = useState<number[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(false);
  const epoch = useRef(new LatestRequestGate()).current;
  useEffect(() => {
    epoch.invalidate();
    setText(undefined);
    setOffset(undefined);
    setPositions([]);
    setLoading(false);
    setError(false);
    return () => {
      epoch.invalidate();
    };
  }, [sessionId, leafId, record.executionId, field, epoch]);
  const load = async (previousOffset?: number) => {
    const request = epoch.begin();
    setLoading(true);
    setError(false);
    try {
      if (payload.ref) {
        const start = previousOffset ?? offset ?? 0;
        const { chunk } = await call("sessions.executionContent", {
          id: sessionId,
          hash: payload.ref.hash,
          offset: start,
          maxBytes: 65536,
        });
        if (!epoch.isCurrent(request) || !chunk) return;
        setText(chunk.text);
        setOffset(chunk.nextOffset);
        setPositions((current) => {
          const index = current.indexOf(start);
          return index >= 0 ? current.slice(0, index + 1) : [...current, start];
        });
      } else {
        const page = await call("sessions.executions", {
          id: sessionId,
          leafId: leafId ?? undefined,
          executionId: record.executionId,
          includeContent: true,
        });
        if (!epoch.isCurrent(request)) return;
        if (!page.records[0]?.[field] || !("value" in page.records[0][field]!))
          throw new Error("Original content is unavailable");
        setText(JSON.stringify(page.records[0]?.[field]?.value, null, 2));
      }
    } catch {
      if (epoch.isCurrent(request)) setError(true);
    } finally {
      if (epoch.isCurrent(request)) setLoading(false);
    }
  };
  return (
    <div>
      <strong>
        {field === "arguments" ? t("executionField_arguments", "Arguments") : t("executionField_result", "Result")}
      </strong>
      {!payload.complete && (
        <p>{payload.reason ?? t("executionContentIncomplete", "The original tool output is incomplete.")}</p>
      )}
      <pre>{text ?? payload.preview ?? JSON.stringify(payload.value, null, 2)}</pre>
      {positions.length > 1 && (
        <button disabled={loading} onClick={() => void load(positions.at(-2))}>
          {t("executionPreviousContent", "Previous content page")}
        </button>
      )}
      {(text === undefined || offset !== undefined) && (
        <button disabled={loading} onClick={() => void load()}>
          {offset !== undefined
            ? t("executionNextContent", "Next content page")
            : t("executionReadOriginal", "Read original content")}
        </button>
      )}
      {error && <p role="alert">{t("executionContentFailed", "Could not read original content.")}</p>}
    </div>
  );
}

function ProcessObservation({ processId }: { processId: string }) {
  const { t } = useI18n(),
    [text, setText] = useState<string>(),
    [loading, setLoading] = useState(false);
  const epoch = useRef(new LatestRequestGate()).current;
  useEffect(() => {
    epoch.invalidate();
    setText(undefined);
    setLoading(false);
    return () => {
      epoch.invalidate();
    };
  }, [processId, epoch]);
  return (
    <div>
      <button
        disabled={loading}
        onClick={() => {
          const request = epoch.begin();
          setLoading(true);
          void call("processes.get", { processId })
            .then((info) => {
              if (epoch.isCurrent(request)) setText(`${info.state} · ${new Date().toLocaleString()}`);
            })
            .catch(() => {
              if (epoch.isCurrent(request))
                setText(t("executionResourceUnavailable", "The resource is no longer available in this Host."));
            })
            .finally(() => {
              if (epoch.isCurrent(request)) setLoading(false);
            });
        }}
      >
        {t("executionVerifyResource", "Check current process state")}
      </button>
      {text && <p role="status">{text}</p>}
    </div>
  );
}
