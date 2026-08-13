export type InitialTheme = "light" | "dark";

interface ThemeInitEnvironment {
  readStoredTheme(): string | null;
  systemPrefersDark(): boolean;
  applyTheme(theme: InitialTheme): void;
}

export function resolveInitialTheme(storedTheme: string | null, prefersDark: boolean): InitialTheme {
  if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
  return prefersDark ? "dark" : "light";
}

export function initializeTheme(environment: ThemeInitEnvironment): InitialTheme {
  let storedTheme: string | null = null;
  try {
    storedTheme = environment.readStoredTheme();
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }

  let prefersDark = false;
  if (storedTheme !== "light" && storedTheme !== "dark") {
    try {
      prefersDark = environment.systemPrefersDark();
    } catch {
      // matchMedia can be unavailable in non-browser or restricted contexts.
    }
  }

  const theme = resolveInitialTheme(storedTheme, prefersDark);
  environment.applyTheme(theme);
  return theme;
}

// Apply the persisted or system theme before React mounts without requiring an inline script CSP exception.
initializeTheme({
  readStoredTheme: () => localStorage.getItem("pi-theme"),
  systemPrefersDark: () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  applyTheme: (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  },
});
