export type CockpitBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function layoutCockpitBounds(area: CockpitBounds): { left: CockpitBounds; right: CockpitBounds } {
  const leftWidth = Math.min(380, Math.max(280, Math.round(area.width * 0.22)));
  const rightWidth = Math.min(560, Math.max(360, Math.round(area.width * 0.28)));
  return {
    left: { x: area.x, y: area.y, width: leftWidth, height: area.height },
    right: { x: area.x + area.width - rightWidth, y: area.y, width: rightWidth, height: area.height },
  };
}
