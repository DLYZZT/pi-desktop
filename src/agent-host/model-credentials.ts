import path from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { withLockedJsonFile, type JsonRecord } from "../shared/node/locked-json-file";

/** SDK credential-store adapter: the actual locked mutation outlives cancelled API callers. */
export class DesktopModelCredentials implements CredentialStore {
  private readonly closing = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private reading?: Promise<JsonRecord>;
  constructor(readonly filename: string) {}

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  private load(): Promise<JsonRecord> {
    this.closing.signal.throwIfAborted();
    if (this.reading) return this.reading;
    const work = this.track(
      withLockedJsonFile(this.filename, async (data) => data, this.closing.signal, { allowEmpty: true }),
    );
    this.reading = work;
    void work.then(
      () => {
        if (this.reading === work) this.reading = undefined;
      },
      () => {
        if (this.reading === work) this.reading = undefined;
      },
    );
    return work;
  }
  async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const data = await this.load();
    options?.signal?.throwIfAborted();
    return structuredClone(data[provider] as Credential | undefined);
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const data = await this.load();
    options?.signal?.throwIfAborted();
    return Object.entries(data).flatMap(([providerId, value]) => {
      const credential = value as Credential | undefined;
      return credential?.type === "api_key" || credential?.type === "oauth"
        ? [{ providerId, type: credential.type }]
        : [];
    });
  }
  async modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    this.closing.signal.throwIfAborted();
    const controller = new AbortController();
    const cancelCaller = () => controller.abort(options?.signal?.reason),
      cancelShutdown = () => controller.abort(this.closing.signal.reason);
    options?.signal?.addEventListener("abort", cancelCaller, { once: true });
    this.closing.signal.addEventListener("abort", cancelShutdown, { once: true });
    if (options?.signal?.aborted) cancelCaller();
    const work = withLockedJsonFile(
      this.filename,
      async (data, save) => {
        // Stop cancels lock waits, not an entered mutation. The SDK separately shields started OAuth refreshes.
        this.closing.signal.removeEventListener("abort", cancelShutdown);
        controller.signal.throwIfAborted();
        const next = await fn(data[provider] as Credential | undefined);
        if (next !== undefined) await save({ ...data, [provider]: next });
        return next ?? (data[provider] as Credential | undefined);
      },
      controller.signal,
      { allowEmpty: true },
    ).finally(() => {
      options?.signal?.removeEventListener("abort", cancelCaller);
      this.closing.signal.removeEventListener("abort", cancelShutdown);
    });
    return this.track(work);
  }
  async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
    this.closing.signal.throwIfAborted();
    const signal = options?.signal ? AbortSignal.any([options.signal, this.closing.signal]) : this.closing.signal;
    return this.track(
      withLockedJsonFile(
        this.filename,
        async (data, save) => {
          const next = { ...data };
          delete next[provider];
          await save(next);
        },
        signal,
        { allowEmpty: true },
      ),
    );
  }
  stopWaiting(): void {
    this.closing.abort(new Error("Model credentials are shutting down"));
  }
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

const stores = new Map<string, DesktopModelCredentials>();
let stopping = false;
export function beginModelCredentialShutdown(): void {
  stopping = true;
  for (const store of stores.values()) store.stopWaiting();
}
export async function settleModelCredentials(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => store.settled()));
}
export function createDesktopModelRuntime(
  options: NonNullable<Parameters<typeof ModelRuntime.create>[0]> = {},
): Promise<ModelRuntime> {
  if (stopping) return Promise.reject(new Error("Model runtime is shutting down"));
  const filename = path.resolve(options.authPath ?? path.join(getAgentDir(), "auth.json"));
  let credentials = options.credentials;
  if (!credentials) {
    let store = stores.get(filename);
    if (!store) {
      store = new DesktopModelCredentials(filename);
      stores.set(filename, store);
    }
    credentials = store;
  }
  return ModelRuntime.create({ ...options, credentials });
}
