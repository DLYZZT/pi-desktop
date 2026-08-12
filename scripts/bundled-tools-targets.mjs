const releasedTargets = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];
const releasedTargetSet = new Set(releasedTargets);

function fail(message) {
  throw new Error(`[bundled-tools] ${message}`);
}

export function parseBundledToolTargets(argv, { platform = process.platform, arch = process.arch } = {}) {
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const target = argv[index + 1];
      if (!target) fail("--target requires platform-arch");
      targets.push(target);
      index += 1;
    } else if (argument === "--all") {
      targets.push(...releasedTargets);
    } else if (argument === "--release") {
      targets.push(`${platform}-${arch}`);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }

  if (targets.length === 0) targets.push(`${platform}-${arch}`);
  const unique = [...new Set(targets)];
  for (const target of unique) {
    if (!releasedTargetSet.has(target)) fail(`unsupported release target: ${target}`);
  }
  return unique;
}
