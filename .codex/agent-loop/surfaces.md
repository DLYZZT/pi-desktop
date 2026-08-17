# Surfaces → cheapest check

| Surface       | Paths                                                                                       | M1 check                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| abort channel | `src/agent-host/rpc-manager.ts`, `src/main/ipc.ts`, `src/renderer/hooks/useAgentSession.ts` | `node scripts/test.mjs src/agent-host/rpc-manager.abort.test.mjs src/renderer/hooks/use-agent-session-abort-contract.test.mjs src/main/ipc-trust.test.mjs` |
