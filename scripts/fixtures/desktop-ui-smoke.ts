/** Manual, no-model fixture. Load only in an isolated development profile. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function desktopUiSmoke(pi: ExtensionAPI) {
  pi.registerCommand("desktop-ui-smoke", {
    description: "Exercise the custom panel without a backend or model request",
    handler: async (_args, ctx) => {
      const ui = ctx.ui as typeof ctx.ui & { getDesktopUiCapabilities?: () => { version: number } | undefined };
      if (ctx.mode !== "tui" && ui.getDesktopUiCapabilities?.()?.version !== 1) {
        ctx.ui.notify("This fixture needs TUI mode or the patched desktop custom UI bridge.", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _keys, done) => {
          let ticks = 0,
            lastInput = "No input yet",
            disposed = false;
          const timer = setInterval(() => {
            ticks++;
            tui.requestRender();
          }, 100);
          return {
            render: (width: number) => [
              theme.fg("accent", theme.bold("Desktop custom UI smoke")),
              `Width: ${width}; rows: ${tui.terminal.rows}; ticks: ${ticks}`,
              "Type, paste Unicode/multiline text, scroll, and resize the window.",
              "Esc closes. Ctrl+C is recorded, not used as the Close button.",
              `Last input: ${lastInput}`,
            ],
            handleInput: (data: string) => {
              if (data === "\x1b") {
                done();
                return;
              }
              lastInput = JSON.stringify(data).slice(0, 160);
              tui.requestRender();
            },
            dispose: () => {
              if (disposed) return;
              disposed = true;
              clearInterval(timer);
            },
          };
        },
        { overlay: true, overlayOptions: { width: "78%", minWidth: 48 } },
      );
      ctx.ui.notify("Custom panel completed. Its repaint timer was disposed.", "info");
    },
  });
}
