import { useEffect, useState, useCallback, useRef } from "react";
import { APP_VERSION, PI_VERSION } from "@/lib/app-version";

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join(""),
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = null;
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, running]);

  return display;
}

export function PiAgentTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const scrambleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${APP_VERSION}p${PI_VERSION}` : "Pi Agent Desktop";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
    setShowVersion(toVersion);
    setScrambling(true);
    scrambleTimerRef.current = setTimeout(
      () => {
        scrambleTimerRef.current = null;
        setScrambling(false);
      },
      (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100,
    );
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => {
        revertTimerRef.current = null;
        triggerScramble(false);
      }, 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(
    () => () => {
      if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
      if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    },
    [],
  );

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "default",
        display: "flex",
        alignItems: "center",
        gap: 8,
        color: showVersion ? "var(--accent)" : "var(--text)",
        minWidth: "6ch",
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: "var(--text)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--accent)",
          fontWeight: 700,
          flexShrink: 0,
        }}
        aria-hidden="true"
      >
        $
      </span>
      <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.2px", fontFamily: "var(--font-mono)" }}>
        {display}
      </span>
    </button>
  );
}
