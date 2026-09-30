export interface CredentialSnapshot {
  provider: string;
  type: "api_key" | "oauth" | null;
  version: string;
}

export interface CredentialMutationOptions {
  expectedVersion?: string;
  replaceExisting?: boolean;
}
