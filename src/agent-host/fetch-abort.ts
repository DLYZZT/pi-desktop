function signalOf(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  if (typeof Request !== "undefined" && input instanceof Request) return input.signal;
  return undefined;
}

/** Cancel an in-flight fetch body when its AbortSignal fires. OpenAI/xAI streams otherwise keep reading. */
export function installFetchBodyAbort(fetchImpl: typeof fetch = globalThis.fetch): () => void {
  const wrapped: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    const signal = signalOf(input, init);
    const body = response.body;
    if (!signal || !body) return response;
    const cancel = () => {
      void body.cancel().catch(() => undefined);
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    return response;
  };
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = fetchImpl;
  };
}
