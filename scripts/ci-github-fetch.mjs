/** Node preload used only by CI download/build commands; application/test fetch is unchanged. */
import { githubReleaseAsset } from "./ci-downloads.mjs";

const retryStatuses = new Set([408, 429, 500, 502, 503, 504]);
const redirectHosts = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

export function createGithubReleaseFetch(fetchImpl, options = {}) {
  const releases = new Map();
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  async function request(url, init) {
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        if (init.signal?.aborted || attempt === 2) throw error;
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!retryStatuses.has(response.status) || attempt === 2) return response;
      await response.body?.cancel().catch(() => undefined);
      await sleep(500 * (attempt + 1));
    }
  }
  return async (input, init = {}) => {
    let asset;
    try {
      asset = githubReleaseAsset(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    } catch {
      return fetchImpl(input, init);
    }
    const method = String(init.method ?? input?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return fetchImpl(input, init);
    const callerSignal = init.signal ?? input?.signal;
    const signal = globalThis.AbortSignal.any([
      ...(callerSignal ? [callerSignal] : []),
      globalThis.AbortSignal.timeout(options.timeoutMs ?? 180000),
    ]);
    const headers = new globalThis.Headers(init.headers ?? input?.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", "Pi-Desktop-CI-Downloads");
    headers.delete("authorization");
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    headers.set("accept", "application/json");
    const key = `${asset.repo}/${asset.tag}`;
    let release = releases.get(key);
    if (!release) {
      const response = await request(
        `https://api.github.com/repos/${asset.repo}/releases/tags/${encodeURIComponent(asset.tag)}`,
        {
          headers,
          signal,
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error(`GitHub release metadata failed (${response.status}) for ${key}`);
      release = await response.json();
      if (!Array.isArray(release.assets)) throw new Error(`Invalid release metadata for ${key}`);
      releases.set(key, release);
    }
    const found = release.assets.find((entry) => entry.name === asset.name);
    if (!found || !Number.isSafeInteger(found.id) || found.id <= 0)
      throw new Error(`Release asset is missing: ${key}/${asset.name}`);
    let current = new URL(`https://api.github.com/repos/${asset.repo}/releases/assets/${found.id}`);
    headers.set("accept", "application/octet-stream");
    for (let redirects = 0; redirects <= 5; redirects++) {
      const requestHeaders = new globalThis.Headers(headers);
      if (current.hostname !== "api.github.com") requestHeaders.delete("authorization");
      const response = await request(current, { ...init, method, headers: requestHeaders, signal, redirect: "manual" });
      if (response.status < 300 || response.status >= 400 || init.redirect === "manual") return response;
      if (init.redirect === "error") throw new Error("Release asset redirect is disallowed");
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirects === 5) throw new Error("Release asset redirect limit exceeded");
      current = new URL(location, current);
      if (
        current.protocol !== "https:" ||
        current.port ||
        current.username ||
        current.password ||
        current.hash ||
        !redirectHosts.has(current.hostname)
      )
        throw new Error("Release asset redirect was rejected");
    }
    throw new Error("Release asset redirect limit exceeded");
  };
}

if (process.env.PI_CI_GITHUB_ASSETS === "1") {
  globalThis.fetch = createGithubReleaseFetch(globalThis.fetch, {
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  });
}
