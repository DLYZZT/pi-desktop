export type WindowRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StoredWindowState = WindowRectangle & {
  isMaximized?: boolean;
};

export type WindowStateSource = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  getNormalBounds(): WindowRectangle;
};

export type DisplayBounds = {
  primary: WindowRectangle;
  all: WindowRectangle[];
};

export type InitialWindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

function validRectangle(bounds: WindowRectangle): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function intersectionArea(a: WindowRectangle, b: WindowRectangle): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function clampSize(value: number, minimum: number, available: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, available)));
}

export function persistableWindowState(source: WindowStateSource): StoredWindowState | undefined {
  if (source.isDestroyed() || source.isMinimized() || source.isFullScreen()) return undefined;
  const bounds = source.getNormalBounds();
  if (!validRectangle(bounds)) return undefined;
  return { ...bounds, isMaximized: source.isMaximized() };
}

export function resolveWindowBounds(
  defaults: InitialWindowBounds,
  stored: Partial<StoredWindowState> | undefined,
  displays?: DisplayBounds,
): InitialWindowBounds {
  if (!stored) return defaults;
  const savedWidth = Math.max(900, stored.width || defaults.width);
  const savedHeight = Math.max(600, stored.height || defaults.height);
  const hasPosition = Number.isFinite(stored.x) && Number.isFinite(stored.y);
  const candidate: WindowRectangle = {
    x: hasPosition ? Number(stored.x) : (defaults.x ?? 0),
    y: hasPosition ? Number(stored.y) : (defaults.y ?? 0),
    width: savedWidth,
    height: savedHeight,
  };
  if (!displays || displays.all.length === 0 || !hasPosition) {
    return {
      ...(hasPosition ? { x: candidate.x, y: candidate.y } : { x: defaults.x, y: defaults.y }),
      width: savedWidth,
      height: savedHeight,
    };
  }

  let target = displays.primary;
  let largestIntersection = 0;
  for (const workArea of displays.all) {
    const area = intersectionArea(candidate, workArea);
    if (area > largestIntersection) {
      largestIntersection = area;
      target = workArea;
    }
  }
  const width = clampSize(savedWidth, 900, target.width);
  const height = clampSize(savedHeight, 600, target.height);
  if (largestIntersection > 0) return { x: candidate.x, y: candidate.y, width, height };

  return {
    x: Math.round(target.x + (target.width - width) / 2),
    y: Math.round(target.y + (target.height - height) / 2),
    width,
    height,
  };
}
