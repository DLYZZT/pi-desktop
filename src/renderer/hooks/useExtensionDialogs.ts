import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ExtensionDialogRequest } from "@shared/types";
import { sendAgentCommand } from "@/lib/agent-client";
import type { RuntimeSnapshotTicket, SessionRuntimeGate } from "@/lib/session-runtime-gate";

type Owner = { request: ExtensionDialogRequest; sid: string; signal: AbortSignal; expiresAt?: number };
type Answer = { value: string } | { confirmed: boolean } | { cancelled: true };

export function useExtensionDialogs(
  sessionId: RefObject<string | null>,
  getSignal: () => AbortSignal,
  gate: SessionRuntimeGate,
) {
  const [dialog, setDialog] = useState<ExtensionDialogRequest | null>(null);
  const pending = useRef(new Map<string, Owner>()).current;
  const closed = useRef(new Set<string>()).current;
  const submitting = useRef(new Set<Owner>()).current;
  const lastSnapshot = useRef(0);
  const current = useRef<Owner | undefined>(undefined);
  const refresh = useCallback(() => {
    current.current = undefined;
    for (const [id, owner] of pending) {
      if (
        owner.sid !== sessionId.current ||
        owner.signal.aborted ||
        owner.signal !== getSignal() ||
        (owner.expiresAt !== undefined && owner.expiresAt <= Date.now())
      )
        pending.delete(id);
      else current.current = owner;
    }
    setDialog(current.current?.request ?? null);
  }, [pending, sessionId, getSignal]);
  const remember = useCallback(
    (request: ExtensionDialogRequest) => {
      if (closed.has(request.id) || !sessionId.current || getSignal().aborted) return;
      const expiresAt = request.expiresAt ?? (request.timeout ? Date.now() + request.timeout : undefined);
      pending.set(request.id, { request, expiresAt, sid: sessionId.current, signal: getSignal() });
    },
    [closed, pending, sessionId, getSignal],
  );
  const restore = useCallback(
    (requests: ExtensionDialogRequest[], ticket: RuntimeSnapshotTicket) => {
      if (!gate.isCurrentRun(ticket) || ticket.sequence < lastSnapshot.current) return;
      lastSnapshot.current = ticket.sequence;
      const newerEvents = !gate.accept(ticket, "dialogs");
      const previous = new Map(pending);
      pending.clear();
      for (const request of requests) {
        const owner = previous.get(request.id);
        if (owner && !owner.signal.aborted && owner.signal === getSignal()) pending.set(request.id, owner);
        else remember(request);
      }
      if (newerEvents) {
        // Newer events own the top of the stack, but cannot invalidate unrelated requests from the snapshot.
        for (const [id, owner] of previous) {
          pending.delete(id);
          pending.set(id, owner);
        }
      } else {
        for (const id of previous.keys()) if (!pending.has(id)) closed.add(id);
      }
      refresh();
    },
    [closed, gate, getSignal, pending, refresh, remember],
  );
  const open = useCallback(
    (request: ExtensionDialogRequest) => {
      gate.touch("dialogs");
      remember(request);
      refresh();
    },
    [gate, refresh, remember],
  );
  const close = useCallback(
    (id: string) => {
      gate.touch("dialogs");
      closed.add(id);
      pending.delete(id);
      refresh();
    },
    [closed, gate, pending, refresh],
  );
  const respond = useCallback(
    async (request: ExtensionDialogRequest, response: Answer) => {
      const owner = current.current;
      if (
        !owner ||
        owner.request !== request ||
        owner.sid !== sessionId.current ||
        owner.signal.aborted ||
        owner.signal !== getSignal()
      )
        return;
      if (submitting.has(owner)) return;
      if (owner.expiresAt !== undefined && owner.expiresAt <= Date.now()) {
        close(request.id);
        return;
      }
      submitting.add(owner);
      try {
        await sendAgentCommand(owner.sid, { type: "extension_ui_response", id: request.id, ...response });
        if (pending.get(request.id) === owner) close(request.id);
      } catch (error) {
        // A transport failure leaves the request available until a Host close or snapshot arrives.
        console.error("Failed to send extension UI response:", error);
      } finally {
        submitting.delete(owner);
      }
    },
    [close, pending, submitting, sessionId, getSignal],
  );
  useEffect(() => {
    const owner = current.current;
    if (!dialog || !owner || owner.expiresAt === undefined) return;
    const timer = setTimeout(() => close(dialog.id), Math.max(0, owner.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [close, dialog]);
  return { dialog, open, close, restore, respond };
}
