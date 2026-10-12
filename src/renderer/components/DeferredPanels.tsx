import { lazy, Suspense, type ComponentProps } from "react";
import { useI18n } from "@/i18n";

const LazySettingsConfig = lazy(() =>
  import("./SettingsConfig").then((module) => ({ default: module.SettingsConfig })),
);
const LazyTerminalDock = lazy(() =>
  import("./herdr/TerminalDock").then((module) => ({ default: module.TerminalDock })),
);

function PanelLoading({ overlay = false }: { overlay?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      style={
        overlay
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              display: "grid",
              placeItems: "center",
              background: "var(--bg-panel)",
            }
          : { padding: 16 }
      }
    >
      {t("loading", "Loading…")}
    </div>
  );
}

export function SettingsConfig(props: ComponentProps<typeof LazySettingsConfig>) {
  return (
    <Suspense fallback={<PanelLoading overlay />}>
      <LazySettingsConfig {...props} />
    </Suspense>
  );
}

export function TerminalDock(props: ComponentProps<typeof LazyTerminalDock>) {
  return (
    <Suspense fallback={<PanelLoading />}>
      <LazyTerminalDock {...props} />
    </Suspense>
  );
}
