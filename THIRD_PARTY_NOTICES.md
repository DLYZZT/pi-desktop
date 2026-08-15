# Third-Party Notices

This notice was reviewed against the Pi Agent Desktop v0.1.8 production dependency graph. The license links below
identify the upstream terms that apply to each component; Pi Agent Desktop does not modify or replace those terms.
A reference-only entry records project lineage and does not mean that the referenced project is bundled with the
application.

## Application and runtime components

| Component                              | Version   | Use in Pi Agent Desktop            | License                                                               | Attribution / source                                                                                        |
| -------------------------------------- | --------- | ---------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@agegr/pi-web`                        | Reference | Early UI reference; not bundled    | [MIT](https://github.com/agegr/pi-web/blob/main/LICENSE)              | [agegr/pi-web](https://github.com/agegr/pi-web); Copyright © 2026 agegr                                     |
| `@earendil-works/pi-ai`                | 0.84.0    | Unified model-provider API         | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)      | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner      |
| `@earendil-works/pi-agent-core`        | 0.84.0    | Agent runtime                      | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)      | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner      |
| `@earendil-works/pi-coding-agent`      | 0.84.0    | Coding Agent and extension runtime | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)      | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner      |
| `@earendil-works/pi-tui`               | 0.84.0    | Pi runtime dependency              | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)      | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner      |
| `@earendil-works/pi-client`            | 0.84.0    | Pi client protocol implementation  | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)      | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner      |
| `@earendil-works/pi-protocol`          | 0.84.0    | Pi protocol types                  | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)      | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner      |
| `@earendil-works/pi-telemetry`         | 0.84.0    | Pi runtime telemetry API           | [MIT](https://github.com/earendil-works/pi/blob/v0.84.0/LICENSE)      | [earendil-works/pi](https://github.com/earendil-works/pi/tree/v0.84.0); Copyright © 2025 Mario Zechner      |
| Tencent `openclaw-weixin` adapted code | 2.4.6     | Weixin channel transport           | [MIT](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/LICENSE) | [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin/tree/v2.4.6); Copyright © 2026 Tencent |
| `@rc-component/qrcode`                 | 2.0.0     | QR-code settings UI                | [MIT](https://github.com/react-component/qrcode/blob/master/LICENSE)  | [react-component/qrcode](https://github.com/react-component/qrcode); Copyright © 2015-present Alipay.com    |
| `@larksuiteoapi/node-sdk`              | 1.71.1    | Feishu/Lark channel transport      | [MIT](https://github.com/larksuite/node-sdk/blob/main/LICENSE)        | [larksuite/node-sdk](https://github.com/larksuite/node-sdk); Copyright © 2022 Lark Technologies Pte. Ltd.   |
| `silk-wasm`                            | 3.7.1     | Weixin SILK voice decoding         | [MIT](https://github.com/idranme/silk-wasm/blob/v3.7.1/LICENSE)       | [idranme/silk-wasm](https://github.com/idranme/silk-wasm/tree/v3.7.1); Copyright © 2024 idranme             |

## Pi 0.84 runtime dependencies

| Component         | Version | License                                                                                  | Attribution / source                                                                                                          |
| ----------------- | ------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `grok-mermaid`    | 0.2.2   | [Apache-2.0](https://github.com/xl0/grok-mermaid/blob/v0.2.2/LICENSE)                    | [xl0/grok-mermaid](https://github.com/xl0/grok-mermaid/tree/v0.2.2); Copyright © 2023-2026 SpaceXAI and © 2026 Alexey Zaytsev |
| `typebox`         | 1.3.7   | [MIT](https://github.com/sinclairzx81/typebox/blob/main/license)                         | [sinclairzx81/typebox](https://github.com/sinclairzx81/typebox)                                                               |
| `undici`          | 8.9.0   | [MIT](https://github.com/nodejs/undici/blob/v8.9.0/LICENSE)                              | [nodejs/undici](https://github.com/nodejs/undici/tree/v8.9.0)                                                                 |
| `protobufjs`      | 7.6.5   | [BSD-3-Clause](https://github.com/protobufjs/protobuf.js/blob/protobufjs-v7.6.5/LICENSE) | [protobufjs/protobuf.js](https://github.com/protobufjs/protobuf.js/tree/protobufjs-v7.6.5)                                    |
| `brace-expansion` | 5.0.9   | [MIT](https://github.com/juliangruber/brace-expansion/blob/v5.0.9/LICENSE)               | [juliangruber/brace-expansion](https://github.com/juliangruber/brace-expansion/tree/v5.0.9)                                   |

## Developer toolchains

Pi Agent Desktop redistributes only the target-specific ripgrep and fd executables in its default installer. The
remaining tools are fixed official releases downloaded to private application storage only after user confirmation.

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

The bundled ripgrep and fd executables are distributed with their upstream license files. Downloaded archives may
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
