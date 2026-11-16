# AGENTS.md

面向在本仓库工作的 AI 编码助手的仓库约定。

## Renderer UI

写任何界面（新页面、面板、对话框、设置区块）前，先读
**[docs/ui-components.md](./docs/ui-components.md)**——`src/renderer/components/ui/`
下的共享组件（Button / Input / Textarea / SecretTextInput / Select）是唯一允许的
控件来源，ESLint 会拦截裸写对应原生元素的代码。

要点速记：

- 颜色一律走语义 token（`var(--text)`、`var(--bg-panel)`…），交互态交给组件的
  CSS class，不写 inline 颜色
- 用户可见文案走 `t("key", "English fallback")`，新 key 同步补
  `src/renderer/i18n-dictionaries.ts` 的中文
- React 19：ref 直接作为 prop 传，不用 forwardRef
- 新组件带同目录 `.test.mjs`；驱动 ui/Select 交互用
  `components/ui/dom-test-env.mjs`

## 验证命令

```bash
npm run typecheck          # 两个 tsconfig
npx eslint src/renderer --max-warnings=0
npm test                   # 全量 node:test
npm run check:architecture # 模块边界与依赖方向
```

## 已知基线

`check:architecture` 只校验模块边界与依赖方向，**不校验行数**。文件大小属于
评审范畴：为了凑行数去抽代码，通常比原来那个长文件更糟。`scripts/architecture-policy.mjs`
里的 `lineLimit` 只是退化模块的兜底阈值，不要给单个文件重设行数上限。
