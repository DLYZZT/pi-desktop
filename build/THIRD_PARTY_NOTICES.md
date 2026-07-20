# Third-Party Toolchain Notices

Pi Agent Desktop can bundle or download the following third-party developer tools. Each component remains subject to its own license terms; the links below point to the upstream license or licensing information for the pinned release.

| Component | Version | License | Upstream notice |
| --- | --- | --- | --- |
| ripgrep | 15.2.0 | MIT OR Unlicense | <https://github.com/BurntSushi/ripgrep/blob/15.2.0/LICENSE-MIT> |
| fd | 10.3.0 | Apache-2.0 OR MIT | <https://github.com/sharkdp/fd/blob/v10.3.0/LICENSE-MIT> |
| Node.js | 24.18.0 | Node.js license and bundled third-party licenses | <https://github.com/nodejs/node/blob/v24.18.0/LICENSE> |
| python-build-standalone / CPython | 3.14.6+20260623 | Python and bundled third-party licenses | <https://gregoryszorc.com/docs/python-build-standalone/main/running.html#licensing> |
| uv | 0.11.29 | Apache-2.0 OR MIT | <https://github.com/astral-sh/uv/blob/0.11.29/LICENSE-MIT> |
| PortableGit | 2.55.0.3 | GPL-2.0-only and bundled third-party licenses | <https://github.com/git-for-windows/git/blob/v2.55.0.windows.3/COPYING> |
| jq | 1.8.2 | MIT | <https://github.com/jqlang/jq/blob/jq-1.8.2/COPYING> |
| Bun | 1.3.14 | MIT with separately licensed bundled components | <https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md> |

The application does not modify or replace these upstream license terms. Managed runtime archives are downloaded only after user confirmation and are not included in the default Pi Agent Desktop installer. The target-specific ripgrep and fd binaries bundled with the installer include their upstream license files alongside the executables.
