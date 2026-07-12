// Apply the persisted theme before React mounts without requiring inline script CSP.
try {
  const theme = localStorage.getItem("pi-theme");
  if (theme === "dark") document.documentElement.classList.add("dark");
} catch {
  // Storage can be unavailable in privacy-restricted renderer contexts.
}
