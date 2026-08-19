# Pi Agent Desktop

Dangerous bash (`rm -rf`, `sudo`, `chmod|chown 777`) is gated by `.pi/extensions/permission-gate.ts`: Once / Session (whole class) / Deny. Session grant dies on new, resume, fork, or `/reload`.
