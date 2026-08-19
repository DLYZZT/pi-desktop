# Pi Agent Desktop

Dangerous bash (`rm -rf`, `sudo`, `chmod|chown 777`) is gated by `F:/Project/claude/skills/config/pi/extensions/permission-gate.ts`: Once / Session (whole class) / Deny. A Session grant lasts for the Pi process.

Global extensions live in `F:/Project/claude/skills/config/pi/extensions`. `$PI_CODING_AGENT_DIR/settings.json` points `extensions` at this folder so every workspace loads the same set.

Past fixes live under `docs/solutions/`, organized by category with searchable YAML frontmatter such as `module`, `problem_type`, and `tags`.
