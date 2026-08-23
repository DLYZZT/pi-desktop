import type { ManagedProcessCapability } from "../../contract/processes.ts";
import type { WindowsManagedProcessHelperResolution } from "../../shared/windows-managed-process-helper.ts";

export function projectManagedProcessCapability(input: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  reaperReady: boolean;
  helper: WindowsManagedProcessHelperResolution | null;
  ownerReady: boolean;
  windowsRelease?: string;
  windowsVersion?: string;
}): ManagedProcessCapability {
  const posixSupported = input.platform === "darwin" || input.platform === "linux";
  const windowsOsSupported =
    input.platform !== "win32" ||
    (/^\d+\./u.test(input.windowsRelease ?? "") &&
      Number.parseInt(input.windowsRelease ?? "0", 10) >= 10 &&
      !/windows server/iu.test(input.windowsVersion ?? ""));
  const windowsSupported = input.platform === "win32" && input.arch === "x64" && windowsOsSupported;
  const helperReady = windowsSupported && input.helper?.ok === true;
  const helperError = input.helper && !input.helper.ok ? input.helper.errorCode : undefined;
  const supported = posixSupported || windowsSupported;
  const ready = supported && input.reaperReady && (posixSupported || (helperReady && input.ownerReady));
  const errorCode: ManagedProcessCapability["errorCode"] = !supported
    ? input.platform === "win32"
      ? input.arch !== "x64"
        ? "ARCH_UNSUPPORTED"
        : "PLATFORM_UNSUPPORTED"
      : "PLATFORM_UNSUPPORTED"
    : !input.reaperReady
      ? "REAPER_UNHEALTHY"
      : windowsSupported && !helperReady
        ? helperError === "HELPER_INTEGRITY"
          ? "HELPER_INTEGRITY"
          : "HELPER_MISSING"
        : windowsSupported && !input.ownerReady
          ? "OWNER_IDENTITY_UNAVAILABLE"
          : undefined;
  return {
    platform: input.platform,
    arch: input.arch,
    supported,
    ready,
    backend: posixSupported ? "posix-group" : windowsSupported ? "windows-job" : "none",
    ...(input.helper?.ok
      ? {
          helperBuildId: input.helper.descriptor.buildId,
          helperProvenance: input.helper.descriptor.provenance,
        }
      : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}
