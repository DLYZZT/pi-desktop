import { useLayoutEffect, useState, type RefObject } from "react";

type ResizeObserverFactory = new (callback: ResizeObserverCallback) => Pick<ResizeObserver, "observe" | "disconnect">;

export function observedElementHeight(element: Pick<HTMLElement, "clientHeight">): number {
  return Math.max(0, Math.round(element.clientHeight));
}

export function observeElementHeight(
  element: HTMLElement,
  onHeight: (height: number) => void,
  Observer: ResizeObserverFactory | undefined = globalThis.ResizeObserver,
): () => void {
  const publish = () => onHeight(observedElementHeight(element));
  publish();
  if (!Observer) return () => {};
  const observer = new Observer(publish);
  observer.observe(element);
  return () => observer.disconnect();
}

export function useObservedElementHeight(ref: RefObject<HTMLElement | null>, fallback = 0): number {
  const [height, setHeight] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeElementHeight(element, setHeight);
  }, [ref]);
  return height;
}
