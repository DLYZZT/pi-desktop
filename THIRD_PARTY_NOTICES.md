# Third-Party Notices

This notice was reviewed against the Pi Agent Desktop v0.1.14 production dependency graph. The license links below
identify the upstream terms that apply to each component; Pi Agent Desktop does not modify or replace those terms.
A reference-only entry records project lineage and does not mean that the referenced project is bundled with the
application.

## Application and runtime components

| Component                              | Version          | Use in Pi Agent Desktop                   | License                                                                                                                          | Attribution / source                                                                                                   |
| -------------------------------------- | ---------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@agegr/pi-web`                        | Reference        | Early UI reference; not bundled           | [MIT](https://github.com/agegr/pi-web/blob/main/LICENSE)                                                                         | [agegr/pi-web](https://github.com/agegr/pi-web); Copyright © 2026 agegr                                                |
| `@earendil-works/pi-ai`                | 0.84.0           | Unified model-provider API                | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)                                                                 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner                 |
| `@earendil-works/pi-agent-core`        | 0.84.0           | Agent runtime                             | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)                                                                 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner                 |
| `@earendil-works/pi-coding-agent`      | 0.84.0           | Coding Agent and extension runtime        | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)                                                                 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner                 |
| `@earendil-works/pi-tui`               | 0.84.0           | Pi runtime dependency                     | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)                                                                 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner                 |
| `@earendil-works/pi-client`            | 0.84.0           | Pi client protocol implementation         | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)                                                                 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner                 |
| `@earendil-works/pi-protocol`          | 0.84.0           | Pi protocol types                         | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)                                                                 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner                 |
| `@earendil-works/pi-telemetry`         | 0.84.0           | Pi runtime telemetry API                  | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)                                                                 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner                 |
| Tencent `openclaw-weixin` adapted code | 2.4.6            | Weixin channel transport                  | [MIT](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/LICENSE)                                                            | [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin/tree/v2.4.6); Copyright © 2026 Tencent            |
| `@rc-component/qrcode`                 | 2.0.0            | QR-code settings UI                       | [MIT](https://github.com/react-component/qrcode/blob/master/LICENSE)                                                             | [react-component/qrcode](https://github.com/react-component/qrcode); Copyright © 2015-present Alipay.com               |
| `@larksuiteoapi/node-sdk`              | 1.71.1           | Feishu/Lark channel transport             | [MIT](https://github.com/larksuite/node-sdk/blob/main/LICENSE)                                                                   | [larksuite/node-sdk](https://github.com/larksuite/node-sdk); Copyright © 2022 Lark Technologies Pte. Ltd.              |
| `@xterm/xterm`                         | 6.0.0            | ANSI terminal rendering for Herdr panes   | [MIT](https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE)                                                                    | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js/tree/6.0.0); Copyright © 2012-2026 Xterm.js contributors        |
| `@xterm/addon-fit`                     | 0.11.0           | Herdr terminal viewport sizing            | [MIT](https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE)                                                                    | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-fit)                                    |
| `silk-wasm`                            | 3.7.1            | Weixin SILK voice decoding                | [MIT](https://github.com/idranme/silk-wasm/blob/v3.7.1/LICENSE)                                                                  | [idranme/silk-wasm](https://github.com/idranme/silk-wasm/tree/v3.7.1); Copyright © 2024 idranme                        |
| Electron                               | 43.1.1           | Desktop application runtime               | [MIT](https://github.com/electron/electron/blob/v43.1.1/LICENSE)                                                                 | [electron/electron](https://github.com/electron/electron/tree/v43.1.1); bundled Chromium notices ship with the runtime |
| Chromium                               | 150.0.7871.114   | Embedded browser runtime                  | [BSD-3-Clause and bundled component licenses](https://chromium.googlesource.com/chromium/src/+/refs/tags/150.0.7871.114/LICENSE) | Embedded by Electron; `LICENSES.chromium.html` is shipped with the runtime                                             |
| Node.js                                | 24.18.0          | Electron-embedded Main runtime            | [Node.js license and bundled notices](https://github.com/nodejs/node/blob/v24.18.0/LICENSE)                                      | Embedded by Electron 43.1.1                                                                                            |
| Rust standard library                  | 1.96.1           | Windows managed-process helper            | [Apache-2.0 OR MIT](https://github.com/rust-lang/rust/tree/1.96.1/LICENSES)                                                      | [rust-lang/rust](https://github.com/rust-lang/rust/tree/1.96.1)                                                        |
| `windows-sys`                          | 0.61.2           | Windows API bindings                      | [Apache-2.0 OR MIT](https://github.com/microsoft/windows-rs/tree/0.61.2/license-apache-2.0)                                      | [microsoft/windows-rs](https://github.com/microsoft/windows-rs/tree/0.61.2)                                            |
| `windows-link`                         | 0.2.1            | Windows import-link support               | [Apache-2.0 OR MIT](https://github.com/microsoft/windows-rs/tree/0.61.2/license-mit)                                             | [microsoft/windows-rs](https://github.com/microsoft/windows-rs/tree/0.61.2)                                            |
| Microsoft Visual C++ runtime           | Per release SBOM | Statically linked into the Windows helper | [Microsoft software license terms](https://go.microsoft.com/fwlink/?LinkId=2086102)                                              | The authoritative native toolset version is recorded in the Windows CycloneDX SBOM                                     |

## Pi 0.84 runtime dependencies

| Component         | Version | License                                                                                  | Attribution / source                                                                                                          |
| ----------------- | ------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `grok-mermaid`    | 0.2.2   | [Apache-2.0](https://github.com/xl0/grok-mermaid/blob/v0.2.2/LICENSE)                    | [xl0/grok-mermaid](https://github.com/xl0/grok-mermaid/tree/v0.2.2); Copyright © 2023-2026 SpaceXAI and © 2026 Alexey Zaytsev |
| `typebox`         | 1.3.7   | [MIT](https://github.com/sinclairzx81/typebox/blob/main/license)                         | [sinclairzx81/typebox](https://github.com/sinclairzx81/typebox)                                                               |
| `undici`          | 8.9.0   | [MIT](https://github.com/nodejs/undici/blob/v8.9.0/LICENSE)                              | [nodejs/undici](https://github.com/nodejs/undici/tree/v8.9.0)                                                                 |
| `protobufjs`      | 7.6.5   | [BSD-3-Clause](https://github.com/protobufjs/protobuf.js/blob/protobufjs-v7.6.5/LICENSE) | [protobufjs/protobuf.js](https://github.com/protobufjs/protobuf.js/tree/protobufjs-v7.6.5)                                    |
| `brace-expansion` | 5.0.9   | [MIT](https://github.com/juliangruber/brace-expansion/blob/v5.0.9/LICENSE)               | [juliangruber/brace-expansion](https://github.com/juliangruber/brace-expansion/tree/v5.0.9)                                   |

## Developer toolchains

Pi Agent Desktop redistributes the target-specific ripgrep, fd, and supported macOS/Linux Herdr executables in its
default installer. Remaining tools are fixed official releases downloaded to private application storage only after
user confirmation.

| Component                         | Version         | Distribution                  | License                                                                                                                                                                  | Upstream source                                                                              |
| --------------------------------- | --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| ripgrep                           | 15.2.0          | Bundled per target            | [MIT OR Unlicense](https://github.com/BurntSushi/ripgrep/blob/15.2.0/COPYING)                                                                                            | [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep/tree/15.2.0)                      |
| fd                                | 10.3.0          | Bundled per target            | [Apache-2.0](https://github.com/sharkdp/fd/blob/v10.3.0/LICENSE-APACHE) OR [MIT](https://github.com/sharkdp/fd/blob/v10.3.0/LICENSE-MIT)                                 | [sharkdp/fd](https://github.com/sharkdp/fd/tree/v10.3.0)                                     |
| Node.js                           | 24.18.0         | Downloaded after confirmation | [Node.js license and bundled notices](https://github.com/nodejs/node/blob/v24.18.0/LICENSE)                                                                              | [nodejs/node](https://github.com/nodejs/node/tree/v24.18.0)                                  |
| npm                               | Node.js-bundled | Downloaded with Node.js       | [Artistic-2.0](https://github.com/npm/cli/blob/v11.16.0/LICENSE)                                                                                                         | [npm/cli](https://github.com/npm/cli)                                                        |
| uv                                | 0.11.29         | Downloaded after confirmation | [Apache-2.0](https://github.com/astral-sh/uv/blob/0.11.29/LICENSE-APACHE) OR [MIT](https://github.com/astral-sh/uv/blob/0.11.29/LICENSE-MIT)                             | [astral-sh/uv](https://github.com/astral-sh/uv/tree/0.11.29)                                 |
| python-build-standalone / CPython | 3.14.6+20260623 | Downloaded after confirmation | [Upstream bundled licenses](https://gregoryszorc.com/docs/python-build-standalone/main/running.html#licensing) and [PSF License](https://docs.python.org/3/license.html) | [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone)    |
| PortableGit                       | 2.55.0.3        | Downloaded on Windows x64     | [GPL-2.0-only and bundled notices](https://github.com/git-for-windows/git/blob/v2.55.0.windows.3/COPYING)                                                                | [git-for-windows/git](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.3) |
| jq                                | 1.8.2           | Downloaded after confirmation | [MIT](https://github.com/jqlang/jq/blob/jq-1.8.2/COPYING)                                                                                                                | [jqlang/jq](https://github.com/jqlang/jq/tree/jq-1.8.2)                                      |
| Bun                               | 1.3.14          | Downloaded after confirmation | [MIT with separately licensed bundled components](https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md)                                                            | [oven-sh/bun](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14)                       |
| Herdr                             | 0.8.2           | Bundled on macOS/Linux        | [Apache-2.0](https://github.com/herdrdev/herdr/blob/v0.8.2/LICENSE)                                                                                                      | [herdrdev/herdr](https://github.com/herdrdev/herdr/tree/v0.8.2)                              |

Windows helper cross-build dependencies are not bundled in the application: `cargo-xwin` 0.23.1 is used under the
[MIT license](https://github.com/rust-cross/cargo-xwin/blob/v0.23.1/LICENSE), LLVM 18 is used under
[Apache-2.0 WITH LLVM-exception](https://github.com/llvm/llvm-project/blob/llvmorg-18.1.8/LICENSE.TXT), and the
downloaded Windows SDK 10.0.26100 / MSVC CRT manifest package 14.44.17.14 (CRT headers build 14.44.35220) remain
governed by the
[Microsoft software license terms](https://go.microsoft.com/fwlink/?LinkId=2086102).

Each Windows release publishes a CycloneDX SBOM generated from the locked production dependency graph. It records
the authoritative Windows-native rustc, Cargo, rustc LLVM backend, Windows SDK and MSVC toolset versions separately
from the fixed cargo-xwin/LLVM/SDK/CRT cross-build gate, together with the exact helper, installer and bundled-tool
hashes.

The bundled ripgrep, fd, and Herdr executables are distributed with their upstream license files. The managed Herdr
activation is copied from the bundled verified runtime together with its Apache-2.0 license text. Downloaded archives may
contain additional components and notices; those upstream files remain authoritative.

## License reference index

| Identifier      | Canonical license text                                   |
| --------------- | -------------------------------------------------------- |
| MIT             | <https://spdx.org/licenses/MIT.html>                     |
| Apache-2.0      | <https://www.apache.org/licenses/LICENSE-2.0>            |
| BSD-3-Clause    | <https://spdx.org/licenses/BSD-3-Clause.html>            |
| Artistic-2.0    | <https://spdx.org/licenses/Artistic-2.0.html>            |
| GPL-2.0-only    | <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html> |
| Unlicense       | <https://unlicense.org/>                                 |
| Python / PSF    | <https://docs.python.org/3/license.html>                 |
| Node.js bundled | <https://github.com/nodejs/node/blob/v24.18.0/LICENSE>   |

Where an upstream version-specific license link and a canonical reference differ, the upstream component's bundled
license and notices are authoritative.
