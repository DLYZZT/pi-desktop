export interface PiRuntimeProbeResult {
  piVersion: string;
  openaiOAuthLoaded: true;
  mcpLoaded: true;
  codemodeMcpRoundTrip?: true;
  codemodeCancellation?: true;
  mcpStdioRoundTrip?: true;
}
