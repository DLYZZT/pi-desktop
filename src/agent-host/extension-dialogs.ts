import { randomUUID } from "node:crypto";
import type { ExtensionDialogRequest, ExtensionUiRequest, ExtensionUiResponse } from "../shared/types";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "type" | "id"> : never;
export type DialogBody = WithoutEnvelope<ExtensionDialogRequest>;

/** A request belongs to the session, including while every view is disconnected. */
export class ExtensionDialogs {
  private pending = new Map<
    string,
    { request: ExtensionDialogRequest; respond(response?: ExtensionUiResponse): void }
  >();

  constructor(private emit: (request: ExtensionUiRequest) => void) {}

  snapshot(): ExtensionDialogRequest[] {
    return Array.from(this.pending.values(), ({ request }) => request);
  }

  get waiting(): boolean {
    return this.pending.size > 0;
  }

  ask<T>(
    body: DialogBody,
    fallback: T,
    parse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(fallback);
    const id = randomUUID();
    const expiresAt = timeout ? Date.now() + timeout : undefined;
    const request: ExtensionDialogRequest = {
      ...body,
      type: "extension_ui_request",
      id,
      ...(expiresAt !== undefined && { timeout, expiresAt }),
    };
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => respond();
      const respond = (response?: ExtensionUiResponse) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        resolve(response && (expiresAt === undefined || Date.now() < expiresAt) ? parse(response) : fallback);
        this.emit({ type: "extension_ui_request", method: "dialog_closed", id });
      };
      this.pending.set(id, { request, respond });
      signal?.addEventListener("abort", cancel, { once: true });
      if (timeout) timer = setTimeout(cancel, timeout);
      this.emit(request);
    });
  }

  answer(response: ExtensionUiResponse): void {
    this.pending.get(response.id)?.respond(response);
  }

  cancelAll(): void {
    for (const item of this.pending.values()) item.respond();
  }
}
