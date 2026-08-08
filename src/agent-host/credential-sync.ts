import type { CredentialInfo, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { CredentialMutationResult } from "../contract/types";

type CredentialRuntime = {
  listCredentials(): Promise<readonly CredentialInfo[]>;
  refresh(options: { allowNetwork: false; providers: readonly string[] }): Promise<ModelsRefreshResult>;
};

export type CredentialTarget = {
  present: boolean;
  type?: CredentialInfo["type"];
};

export async function credentialStateMatches(
  runtime: Pick<CredentialRuntime, "listCredentials">,
  providerId: string,
  target: CredentialTarget,
): Promise<boolean> {
  const credentials = await runtime.listCredentials();
  const matches = credentials.some(
    (entry) => entry.providerId === providerId && (target.type === undefined || entry.type === target.type),
  );
  return target.present ? matches : !matches;
}

export async function recoverCommittedCredential(
  runtime: CredentialRuntime,
  providerId: string,
  target: CredentialTarget,
): Promise<CredentialMutationResult | null> {
  if (!(await credentialStateMatches(runtime, providerId, target))) return null;

  try {
    const result = await runtime.refresh({ allowNetwork: false, providers: [providerId] });
    if (!result.aborted && result.errors.size === 0) return { ok: true, synchronized: true };
  } catch {
    // The credential state is authoritative. Surface a safe warning below.
  }

  return {
    ok: true,
    synchronized: false,
    warning: {
      code: "MODEL_SYNC_FAILED",
      message: "Credentials were updated, but the local model state could not be refreshed. Retry model refresh.",
    },
  };
}
