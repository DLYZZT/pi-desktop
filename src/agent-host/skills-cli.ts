const SKILLS_CLI_PACKAGE = "skills@1.5.22";

export function buildSkillsCliArgs(args: string[]): string[] {
  // Pin the executable package so a failed unversioned npx install cannot
  // poison every later invocation under the same shared cache key.
  return ["--yes", "--package", SKILLS_CLI_PACKAGE, "--", "skills", ...args];
}
