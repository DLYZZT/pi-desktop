import { useState, useRef, useCallback, useEffect } from "react";

const SOUND_ENABLED_STORAGE_KEY = "pi-sound-enabled";

type SoundPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readSoundEnabled(storage?: Pick<SoundPreferenceStorage, "getItem">): boolean {
  try {
    const stored = (storage ?? window.localStorage).getItem(SOUND_ENABLED_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function persistSoundEnabled(enabled: boolean, storage?: Pick<SoundPreferenceStorage, "setItem">): void {
  try {
    (storage ?? window.localStorage).setItem(SOUND_ENABLED_STORAGE_KEY, String(enabled));
  } catch {
    // Keep the in-memory preference when storage is unavailable or full.
  }
}

function playTone(ctx: AudioContext) {
  const now = ctx.currentTime;
  const freqs = [523.25, 659.25];
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}

export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return readSoundEnabled();
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Reuse a single AudioContext so it can be resumed if the browser
  // autoplay policy suspends it (contexts created outside user gestures
  // start in "suspended" state and produce no sound).
  const ctxRef = useRef<AudioContext | null>(null);
  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      ctxRef.current = new AudioContext();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  const unlockAudio = useCallback(
    (force = false) => {
      if (!force && !enabledRef.current) return;
      const ctx = getCtx();
      if (!ctx || ctx.state !== "suspended") return;
      ctx.resume().catch(() => {});
    },
    [getCtx],
  );

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    enabledRef.current = next;
    persistSoundEnabled(next);
    setEnabled(next);
  }, [unlockAudio]);

  const playDone = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    const play = () => {
      try {
        playTone(ctx);
      } catch {
        // AudioContext not available
      }
    };
    if (ctx.state === "suspended") {
      ctx
        .resume()
        .then(play)
        .catch(() => {});
      return;
    }
    play();
  }, [getCtx]);

  return {
    soundEnabled: enabled,
    onSoundToggle: toggle,
    playDoneSound: playDone,
    unlockAudio,
    soundEnabledRef: enabledRef,
  };
}
