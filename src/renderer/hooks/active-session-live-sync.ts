import type { Streams } from "../../contract/api";

type Unsubscribe = () => void;

export interface ActiveSessionLiveSyncOptions {
  sessionId: string;
  connectAgentEvents: (sessionId: string) => Promise<Unsubscribe>;
  subscribeSessionChanges: (onChange: (event: Streams["sessions.changed"]) => void) => Promise<Unsubscribe>;
  onSessionChanged: (event: Streams["sessions.changed"]) => void;
}

/**
 * Keep an opened session live even while it is idle. Agent events provide
 * streaming updates; sessions.changed is the durable completion fallback for
 * turns initiated outside the desktop UI (for example Telegram or WeChat).
 */
export async function subscribeActiveSessionLiveSync(options: ActiveSessionLiveSyncOptions): Promise<Unsubscribe> {
  const unsubscribeAgent = await options.connectAgentEvents(options.sessionId);
  let unsubscribeChanges: Unsubscribe | undefined;
  try {
    unsubscribeChanges = await options.subscribeSessionChanges((event) => {
      if (event.sessionId === options.sessionId) options.onSessionChanged(event);
    });
  } catch (error) {
    unsubscribeAgent();
    throw error;
  }

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    unsubscribeChanges?.();
    unsubscribeAgent();
  };
}
