import { Fragment, Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

const enabled = import.meta.env.DEV && new URLSearchParams(window.location.search).get("sessionProfiler") === "1";

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  console.debug(
    `[perf:sessions:react] ${JSON.stringify({
      id,
      phase,
      actualDuration: Math.round(actualDuration * 10) / 10,
      baseDuration: Math.round(baseDuration * 10) / 10,
      startTime: Math.round(startTime * 10) / 10,
      commitTime: Math.round(commitTime * 10) / 10,
    })}`,
  );
};

/** Opt-in development profiler: launch with `?sessionProfiler=1` to emit content-free timings. */
export function SessionProfiler({ id, children }: { id: string; children: ReactNode }) {
  if (!enabled) return <Fragment>{children}</Fragment>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
