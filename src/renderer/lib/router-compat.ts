export interface RouterCompat {
  replace: (url: string, options?: { scroll?: boolean }) => void;
}

export const routerCompat: RouterCompat = Object.freeze({
  replace(url: string, _options?: { scroll?: boolean }) {
    const next = url.startsWith("?") || url.startsWith("/") ? url : `?${url}`;
    const full = next.startsWith("?") ? `${window.location.pathname}${next}` : next;
    const destination = full === "/" ? "/" : full;
    const hash = destination.includes("#") ? "" : window.location.hash;
    window.history.replaceState(null, "", `${destination}${hash}`);
    window.dispatchEvent(new Event("popstate"));
  },
});

export function readSessionIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("session");
}
