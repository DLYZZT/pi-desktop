import { useCallback, useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

type ToggleOrigin = { x: number; y: number };

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Follow OS theme when user has not forced a preference (or chose system)
  useEffect(() => {
    const storedTheme = (): string | null => {
      try {
        return localStorage.getItem("pi-theme");
      } catch {
        return null;
      }
    };
    if (storedTheme() === "light" || storedTheme() === "dark") return;

    const applySystem = () => {
      // Re-check on every invocation: toggling the theme flips Electron's
      // nativeTheme, which fires this media-query listener again. Without
      // this guard the listener resets themeSource to "system" and reverts
      // the toggle (feedback loop).
      const stored = storedTheme();
      if (stored === "light" || stored === "dark") return;
      const dark = systemPrefersDark();
      document.documentElement.classList.toggle("dark", dark);
      listeners.forEach((cb) => cb());
      void window.piBridge?.setThemeSource?.("system");
    };
    applySystem();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => applySystem();
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    const next: Theme = getSnapshot() === "dark" ? "light" : "dark";

    const apply = () => {
      if (next === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      try {
        localStorage.setItem("pi-theme", next);
      } catch {
        // ignore storage errors (private mode, quota, etc.)
      }
      void window.piBridge?.setThemeSource?.(next);
      listeners.forEach((cb) => cb());
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 450,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // transition cancelled — ignore
      });
  }, []);

  return { theme, toggleTheme, isDark: theme === "dark" };
}
