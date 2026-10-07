import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpConfigurationSnapshot, McpExposure, McpScope, McpServerConfig } from "../../contract/mcp";
import { RpcError } from "../../contract/types";
import { mcpNamespace } from "./oauth-identity";
import { parseJsonRecord, withLockedJsonFile, type JsonRecord } from "../../shared/node/locked-json-file";

export const SAVED_MCP_SECRET = "<pi-desktop:saved-secret>";
const EXPOSURES = new Set(["direct", "deferred", "codemode", "codemode-deferred", "hidden"]);
const object = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const revision = (value: JsonRecord | undefined) =>
  value === undefined ? "missing" : "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function assertMcpServerNames(names: readonly string[]): void {
  const used = new Map<string, string>();
  for (const name of names) {
    const namespace = mcpNamespace(name),
      previous = used.get(namespace);
    if (previous !== undefined && previous !== name)
      throw new RpcError({ code: "BAD_REQUEST", message: "MCP server names conflict: " + previous + " and " + name });
    used.set(namespace, name);
  }
}

export function validateMcpConfig(
  name: unknown,
  value: unknown,
  scope?: McpScope | "extension",
): asserts value is McpServerConfig {
  const fail = (message: string): never => {
    throw new RpcError({ code: "BAD_REQUEST", message });
  };
  if (
    typeof name !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,128}$/u.test(name) ||
    ["__proto__", "prototype", "constructor"].includes(name)
  )
    fail("Invalid MCP server name");
  if (!object(value)) fail("MCP configuration must be an object");
  const config = value as JsonRecord;
  if (config.type !== undefined && config.type !== "stdio" && config.type !== "http")
    fail("Only stdio and Streamable HTTP MCP transports are supported");
  const http = config.type === "http" || config.url !== undefined;
  if (http) {
    if (typeof config.url !== "string" || config.command !== undefined || config.type === "stdio")
      fail("HTTP MCP configuration requires a URL and no command");
    try {
      const url = new URL(config.url as string);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
        fail("MCP URL must be HTTP(S) without userinfo or a fragment");
    } catch {
      fail("Invalid MCP HTTP URL");
    }
  } else if (
    typeof config.command !== "string" ||
    !config.command.trim() ||
    config.command.length > 4096 ||
    config.type === "http"
  )
    fail("Stdio MCP configuration requires a command");
  if (
    config.args !== undefined &&
    (!Array.isArray(config.args) ||
      config.args.length > 256 ||
      config.args.some((arg) => typeof arg !== "string" || arg.length > 32768))
  )
    fail("MCP args must be an array of strings");
  if (config.cwd !== undefined && (typeof config.cwd !== "string" || config.cwd.length > 4096)) fail("Invalid MCP cwd");
  for (const key of ["env", "headers"])
    if (
      config[key] !== undefined &&
      (!object(config[key]) ||
        Object.keys(config[key]).length > 128 ||
        Object.values(config[key]).some((v) => typeof v !== "string" || v.length > 32768))
    )
      fail(`MCP ${key} must contain string values`);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") fail("Invalid MCP enabled flag");
  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== "number" ||
      !Number.isFinite(config.timeout) ||
      config.timeout <= 0 ||
      config.timeout > 3600)
  )
    fail("MCP timeout must be between 0 and 3600 seconds");
  if (config.exposure !== undefined && !EXPOSURES.has(String(config.exposure))) fail("Invalid MCP exposure");
  if (
    config.toolExposure !== undefined &&
    (!object(config.toolExposure) || Object.values(config.toolExposure).some((v) => !EXPOSURES.has(String(v))))
  )
    fail("Invalid MCP tool exposure override");
  if (config.description !== undefined && typeof config.description !== "string") fail("Invalid MCP description");
  if (config.auth !== undefined) {
    if (!http || !object(config.auth) || typeof config.auth.provider !== "string" || !config.auth.provider.trim())
      fail("MCP auth.provider requires an HTTP server and a provider name");
    if (scope === "project") fail("MCP auth.provider is only allowed in global configuration or extensions");
    const url = new URL(config.url as string);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      fail("MCP provider authentication requires HTTPS or a loopback URL");
  }
  if (config.oauth !== undefined) {
    if (!http || !object(config.oauth)) fail("OAuth requires HTTP MCP configuration");
    const oauth = config.oauth as JsonRecord;
    for (const key of ["clientId", "clientSecret", "callbackUrl", "scope", "clientName", "authServerMetadataUrl"])
      if (oauth[key] !== undefined && typeof oauth[key] !== "string") fail(`Invalid MCP OAuth ${key}`);
    if (oauth.clientName !== undefined && !(oauth.clientName as string).trim())
      fail("MCP OAuth clientName cannot be empty");
    if (oauth.authServerMetadataUrl !== undefined) {
      try {
        const url = new URL(oauth.authServerMetadataUrl as string);
        if (
          url.username ||
          url.password ||
          url.hash ||
          !(
            url.protocol === "https:" ||
            (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
          )
        )
          fail("MCP OAuth metadata URL requires HTTPS or a loopback HTTP URL");
      } catch {
        fail("Invalid MCP OAuth metadata URL");
      }
    }
    if (oauth.clientRegistration !== undefined && !["dcr", "cimd"].includes(String(oauth.clientRegistration)))
      fail("MCP OAuth clientRegistration must be dcr or cimd");
    if (oauth.clientRegistration === "cimd" && (oauth.clientId !== undefined || oauth.clientName !== undefined))
      fail("MCP CIMD cannot be combined with clientId or clientName");
    if (
      oauth.callbackPort !== undefined &&
      (!Number.isSafeInteger(oauth.callbackPort) ||
        Number(oauth.callbackPort) < 0 ||
        Number(oauth.callbackPort) > 65535)
    )
      fail("Invalid MCP OAuth callback port");
    if (oauth.callbackUrl !== undefined) {
      try {
        const url = new URL(oauth.callbackUrl as string);
        if (
          url.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          fail("MCP OAuth callback must be an HTTP loopback URL");
        if (oauth.clientRegistration === "cimd" && (url.hostname === "[::1]" || url.pathname !== "/callback"))
          fail("MCP CIMD requires localhost or 127.0.0.1 with callback path /callback");
      } catch {
        fail("Invalid MCP OAuth callback URL");
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(config)) > 1024 * 1024)
    fail("MCP server configuration exceeds the storage budget");
}

export function mcpToolExposure(config: McpServerConfig, name: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, name)) return overrides[name]!;
  for (const [pattern, exposure] of Object.entries(overrides)) {
    const regex = new RegExp(
      "^" +
        pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join(".*") +
        "$",
    );
    if (regex.test(name)) return exposure;
  }
  return config.exposure ?? "codemode";
}

function secretReference(value: string): boolean {
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/iu.test(value);
}
export function projectConfig(config: McpServerConfig): { config: McpServerConfig; secretFields: string[] } {
  const copy = structuredClone(config),
    secretFields: string[] = [];
  for (const key of ["env", "headers"] as const)
    for (const [name, value] of Object.entries(copy[key] ?? {}))
      if (!secretReference(value)) {
        copy[key]![name] = SAVED_MCP_SECRET;
        secretFields.push(`${key}.${name}`);
      }
  if (copy.oauth?.clientSecret && !secretReference(copy.oauth.clientSecret)) {
    copy.oauth.clientSecret = SAVED_MCP_SECRET;
    secretFields.push("oauth.clientSecret");
  }
  return { config: copy, secretFields };
}
export function restoreSecrets(config: McpServerConfig, previous?: McpServerConfig): McpServerConfig {
  const copy = structuredClone(config);
  for (const key of ["env", "headers"] as const)
    for (const [name, value] of Object.entries(copy[key] ?? {}))
      if (value === SAVED_MCP_SECRET) {
        const old = previous?.[key]?.[name];
        if (old === undefined) throw new RpcError({ code: "CONFLICT", message: "Saved MCP secret no longer exists" });
        copy[key]![name] = old;
      }
  if (copy.oauth?.clientSecret === SAVED_MCP_SECRET) {
    if (!previous?.oauth?.clientSecret)
      throw new RpcError({ code: "CONFLICT", message: "Saved MCP OAuth secret no longer exists" });
    copy.oauth.clientSecret = previous.oauth.clientSecret;
  }
  return copy;
}

export class McpConfigStore {
  constructor(private readonly agentDir = getAgentDir()) {}
  filename(scope: McpScope, cwd?: string): string {
    if (scope === "global") return path.join(this.agentDir, "mcp.json");
    if (scope !== "project" || !cwd || !path.isAbsolute(cwd))
      throw new RpcError({ code: "BAD_REQUEST", message: "Project MCP configuration requires an absolute cwd" });
    return path.join(cwd, ".pi", "mcp.json");
  }
  private async read(scope: McpScope, cwd?: string): Promise<JsonRecord | undefined> {
    try {
      const text = await readFile(this.filename(scope, cwd), "utf8");
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("MCP configuration exceeds the read budget");
      const doc = parseJsonRecord(text);
      if (doc.mcpServers !== undefined && !object(doc.mcpServers)) throw new Error("mcpServers must be an object");
      assertMcpServerNames(Object.keys((doc.mcpServers ?? {}) as JsonRecord));
      if (doc.autoEnableCodemode !== undefined && typeof doc.autoEnableCodemode !== "boolean")
        throw new Error("Invalid autoEnableCodemode flag");
      return doc;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async snapshot(scope: McpScope, cwd?: string): Promise<McpConfigurationSnapshot> {
    try {
      const doc = await this.read(scope, cwd),
        entries: McpConfigurationSnapshot["entries"] = [];
      for (const [name, config] of Object.entries((doc?.mcpServers ?? {}) as JsonRecord)) {
        validateMcpConfig(name, config, scope);
        entries.push({ name, scope, source: this.filename(scope, cwd), ...projectConfig(config) });
      }
      return {
        scope,
        cwd,
        revision: revision(doc),
        entries,
        autoEnableCodemode: doc?.autoEnableCodemode as boolean | undefined,
      };
    } catch (error) {
      return {
        scope,
        cwd,
        revision: "invalid",
        entries: [],
        error: error instanceof Error ? error.message : "Invalid MCP configuration",
      };
    }
  }
  async effective(
    cwd: string,
    trusted: boolean,
  ): Promise<{
    servers: Array<{ name: string; config: McpServerConfig; scope: McpScope; source: string; revision: string }>;
    autoEnableCodemode: boolean;
    errors: string[];
  }> {
    const servers = new Map<
      string,
      { name: string; config: McpServerConfig; scope: McpScope; source: string; revision: string }
    >();
    let autoEnableCodemode = true;
    const errors: string[] = [];
    for (const scope of trusted ? (["global", "project"] as const) : (["global"] as const)) {
      try {
        const doc = await this.read(scope, cwd);
        if (typeof doc?.autoEnableCodemode === "boolean") autoEnableCodemode = doc.autoEnableCodemode;
        for (const [name, config] of Object.entries((doc?.mcpServers ?? {}) as JsonRecord)) {
          validateMcpConfig(name, config, scope);
          assertMcpServerNames([...servers.keys(), name]);
          servers.set(name, { name, config, scope, source: this.filename(scope, cwd), revision: revision(doc) });
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Invalid MCP configuration");
      }
    }
    return { servers: [...servers.values()], autoEnableCodemode, errors };
  }
  async upsert(
    scope: McpScope,
    cwd: string | undefined,
    name: string,
    config: McpServerConfig,
    expectedRevision: string,
  ): Promise<McpConfigurationSnapshot> {
    validateMcpConfig(name, config, scope);
    await this.mutate(scope, cwd, expectedRevision, (doc) => {
      const servers = { ...((doc.mcpServers as JsonRecord) ?? {}) },
        previous = servers[name] as McpServerConfig | undefined;
      servers[name] = restoreSecrets(config, previous);
      doc.mcpServers = servers;
    });
    return this.snapshot(scope, cwd);
  }
  async remove(
    scope: McpScope,
    cwd: string | undefined,
    name: string,
    expectedRevision: string,
  ): Promise<McpConfigurationSnapshot> {
    validateMcpConfig(name, { command: "validation-only" });
    await this.mutate(scope, cwd, expectedRevision, (doc) => {
      const servers = { ...((doc.mcpServers as JsonRecord) ?? {}) };
      delete servers[name];
      doc.mcpServers = servers;
    });
    return this.snapshot(scope, cwd);
  }
  async preflight(
    scope: McpScope,
    cwd: string | undefined,
    json: string,
  ): Promise<{ entries: string[]; conflicts: string[] }> {
    if (typeof json !== "string" || Buffer.byteLength(json) > 4 * 1024 * 1024)
      throw new RpcError({ code: "BAD_REQUEST", message: "MCP import exceeds the read budget" });
    const input = parseJsonRecord(json);
    if (!object(input.mcpServers))
      throw new RpcError({ code: "BAD_REQUEST", message: "MCP import requires mcpServers" });
    for (const [name, config] of Object.entries(input.mcpServers)) validateMcpConfig(name, config, scope);
    const current = await this.read(scope, cwd);
    assertMcpServerNames([...Object.keys((current?.mcpServers ?? {}) as JsonRecord), ...Object.keys(input.mcpServers)]);
    return {
      entries: Object.keys(input.mcpServers),
      conflicts: Object.keys(input.mcpServers).filter((name) =>
        Object.hasOwn((current?.mcpServers as JsonRecord) ?? {}, name),
      ),
    };
  }
  async import(
    scope: McpScope,
    cwd: string | undefined,
    json: string,
    expectedRevision: string,
  ): Promise<McpConfigurationSnapshot> {
    await this.preflight(scope, cwd, json);
    const input = parseJsonRecord(json);
    await this.mutate(scope, cwd, expectedRevision, (doc) => {
      const servers = { ...((doc.mcpServers as JsonRecord) ?? {}) };
      for (const [name, config] of Object.entries(input.mcpServers as JsonRecord))
        servers[name] = restoreSecrets(config as McpServerConfig, servers[name] as McpServerConfig | undefined);
      doc.mcpServers = servers;
      if (input.autoEnableCodemode !== undefined) {
        if (typeof input.autoEnableCodemode !== "boolean")
          throw new RpcError({ code: "BAD_REQUEST", message: "Invalid autoEnableCodemode flag" });
        doc.autoEnableCodemode = input.autoEnableCodemode;
      }
    });
    return this.snapshot(scope, cwd);
  }
  private async mutate(
    scope: McpScope,
    cwd: string | undefined,
    expected: string,
    change: (doc: JsonRecord) => void,
  ): Promise<void> {
    if (typeof expected !== "string" || expected === "invalid")
      throw new RpcError({ code: "BAD_REQUEST", message: "A valid MCP configuration revision is required" });
    const filename = this.filename(scope, cwd);
    await withLockedJsonFile(filename, async (doc, save) => {
      const current = revision(await this.read(scope, cwd));
      if (current !== expected)
        throw new RpcError({ code: "CONFLICT", message: "MCP configuration changed; reload before saving" });
      if (doc.mcpServers !== undefined && !object(doc.mcpServers))
        throw new RpcError({ code: "BAD_REQUEST", message: "mcpServers must be an object" });
      change(doc);
      assertMcpServerNames(Object.keys((doc.mcpServers ?? {}) as JsonRecord));
      await save(doc);
    });
  }
}
