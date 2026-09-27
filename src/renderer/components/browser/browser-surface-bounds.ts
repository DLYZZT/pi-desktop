type RectangleEdges = Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;

/** Native views are not clipped by the renderer's overflow rules. */
export function browserSurfaceBounds(
  surface: RectangleEdges,
  panel: RectangleEdges,
): { x: number; y: number; width: number; height: number } | null {
  const panelLeft = Math.ceil(panel.left);
  const panelTop = Math.ceil(panel.top);
  const panelRight = Math.floor(panel.right);
  const panelBottom = Math.floor(panel.bottom);
  if (
    ![panelLeft, panelTop, panelRight, panelBottom].every(Number.isFinite) ||
    panelRight <= panelLeft ||
    panelBottom <= panelTop
  )
    return null;
  const left = Math.ceil(Math.max(surface.left, panel.left));
  const top = Math.ceil(Math.max(surface.top, panel.top));
  const right = Math.floor(Math.min(surface.right, panel.right));
  const bottom = Math.floor(Math.min(surface.bottom, panel.bottom));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    // Keep a stale native view inside the panel until the surface is laid out again.
    return { x: panelLeft, y: panelTop, width: 1, height: 1 };
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
