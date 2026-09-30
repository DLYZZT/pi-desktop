import { createHash } from "node:crypto";
import path from "node:path";
import { CredentialSynchronizationError, getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, Credential, LoginOptions } from "@earendil-works/pi-ai";
import type { CredentialMutationOptions, CredentialSnapshot } from "../contract/auth";
import { RpcError } from "../contract/types";
import { withLockedJsonFile, type JsonRecord } from "../shared/node/locked-json-file";

function snapshot(provider: string, data: JsonRecord): CredentialSnapshot {
  const credential = data[provider] as Credential | undefined;
  if (credential && credential.type !== "api_key" && credential.type !== "oauth")
    throw new Error("Stored credential has an unsupported type");
  return {
    provider,
    type: credential?.type ?? null,
    version: createHash("sha256")
      .update(JSON.stringify(credential ?? null))
      .digest("hex"),
  };
}

function assertVersion(current: CredentialSnapshot, expected: string | undefined): void {
  if (expected !== undefined && expected !== current.version)
    throw new RpcError({ code: "CONFLICT", message: "Credentials changed. Reload providers and confirm again." });
}

export class CredentialMutations {
  constructor(private readonly authPath = path.join(getAgentDir(), "auth.json")) {}

  snapshot(provider: string): Promise<CredentialSnapshot> {
    return withLockedJsonFile(this.authPath, async (data) => snapshot(provider, data));
  }

  async login(
    runtime: ModelRuntime,
    provider: string,
    type: "api_key" | "oauth",
    interaction: AuthInteraction,
    options?: LoginOptions,
    mutation: CredentialMutationOptions = {},
  ): Promise<Credential> {
    const before = await this.snapshot(provider);
    assertVersion(before, mutation.expectedVersion);
    if (before.type !== null && before.type !== type && mutation.replaceExisting !== true) {
      throw new RpcError({
        code: "CONFLICT",
        message: "Changing authentication method requires replacement confirmation.",
      });
    }
    if (before.type !== null && before.type !== type && mutation.expectedVersion === undefined) {
      throw new RpcError({
        code: "CONFLICT",
        message: "Replacement confirmation must include the current credential version.",
      });
    }
    const definition = runtime.getProvider(provider);
    const method = type === "api_key" ? definition?.auth.apiKey : definition?.auth.oauth;
    if (!method?.login)
      throw new RpcError({ code: "BAD_REQUEST", message: `${provider} does not support ${type} login` });
    const signal = interaction.signal ?? new AbortController().signal;
    const credential = await method.login({ ...interaction, signal }, options);
    signal.throwIfAborted();
    if (credential.type !== type) throw new Error("Provider returned the wrong credential type");
    await withLockedJsonFile(
      this.authPath,
      async (data, save) => {
        assertVersion(snapshot(provider, data), before.version);
        await save({ ...data, [provider]: credential });
      },
      signal,
    );
    await this.synchronize(runtime, provider, "login", credential);
    return credential;
  }

  async logout(
    runtime: ModelRuntime,
    provider: string,
    type: "api_key" | "oauth",
    expectedVersion?: string,
  ): Promise<void> {
    await withLockedJsonFile(this.authPath, async (data, save) => {
      const current = snapshot(provider, data);
      assertVersion(current, expectedVersion);
      if (current.type !== null && current.type !== type)
        throw new RpcError({
          code: "CONFLICT",
          message: "The stored authentication method does not match this operation.",
        });
      if (current.type === null) return;
      const next = { ...data };
      delete next[provider];
      await save(next);
    });
    await this.synchronize(runtime, provider, "logout", undefined);
  }

  private async synchronize(
    runtime: ModelRuntime,
    provider: string,
    operation: "login" | "logout",
    credential: Credential | undefined,
  ): Promise<void> {
    try {
      const result = await runtime.refresh({ allowNetwork: false, providers: [provider] });
      if (result.aborted || result.errors.size > 0) throw new Error("Local model state could not be refreshed");
    } catch (cause) {
      throw new CredentialSynchronizationError(provider, operation, credential, { cause });
    }
  }
}

let shared: CredentialMutations | undefined;
export function getCredentialMutations(): CredentialMutations {
  return (shared ??= new CredentialMutations());
}
