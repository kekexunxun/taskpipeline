# Phase 0.5 — Vue 符号抽取方案验证结论

> 目的:决定 mini-Atlas 的 Vue extractor 走 `tree-sitter-vue` grammar,还是 `@vue/compiler-sfc` 拆分 + TS grammar 兜底路径。
> 结论:**采用 compiler-sfc 拆分 + tree-sitter-typescript 的混合路径。**

## 测试环境

- `web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`(含 `tree-sitter-vue.wasm` 23KB、`tree-sitter-typescript.wasm`)+ `@vue/compiler-sfc@3`。
- 样本:**438 个真实 `.vue`**,来自 `adaptor-saas-cloud-front`(174)+ `adaptor-suit-front-new`(264),排除 `node_modules`。
- 对照法(oracle):用官方 `@vue/compiler-sfc` `parse(source,{filename})` 拆出 `<script>`/`<script setup>` 块内容,再用 `tree-sitter-typescript` grammar 解析,取顶层声明作为 ground truth;行位置用 script 块 `loc.start.line` 做偏移还原到整文件坐标。

## 关键数据

| 指标                                           | 数值                 | 判定                          |
| ---------------------------------------------- | -------------------- | ----------------------------- |
| **tree-sitter-vue 从 `<script>` 抽到的符号数** | **0 / 438 文件**     | ❌ 不达标(阈值 90%)           |
| tree-sitter-vue 整文件解析无错率               | 99.5%(436/438)       | ✅ 模板结构可靠               |
| `@vue/compiler-sfc` 解析错误                   | **0 / 438(0%)**      | ✅ 官方拆分器对真实文件全兼容 |
| compiler-sfc + TS grammar 抽出符号             | **3,889**            | ✅ 产出充足                   |
| 符号行偏移正确率(名字落在计算行上)             | **99.9%**(3886/3889) | ✅ 偏移数学正确               |

## 根因

`tree-sitter-vue` 的 SFC 语法把 `<script>` / `<script setup>` 的内容整块表示为一个 **`raw_text` 叶节点**(只给块边界与行偏移,**不解析内部 JS/TS**)。因此:

- 靠它抽 script 里的 function / class / composable / `defineProps<T>` 字段 = **完全拿不到**(0 命中)。
- 它只对 **`<template>` 结构**(element / directive_attribute / 组件标签)有价值。

这解释了 `@colbymchenry/codegraph` 自身的 wasm 集只带 `javascript/tsx/typescript`、**不带 vue**——它同样是在 JS 层拆 SFC,再把 script 段交给 TS 语法解析(与我们实测到的它会抽到 Vue `onSubmit` 一致)。

## 决定:Vue extractor = 混合式

1. **脚本符号**(主战场,导航价值最高):
   - `@vue/compiler-sfc.parse()` 拆出 `descriptor.scriptSetup || descriptor.script`。
   - 取 `block.content` + `block.lang`(ts/tsx → typescript/tsx grammar;js → javascript grammar)+ `block.loc.start.line` 偏移。
   - 用对应 grammar 解析,抽顶层 `function_declaration / class_declaration / interface_declaration / type_alias_declaration / enum_declaration / lexical_declaration(variable_declarator)`,以及 `export_statement` 包裹层。
   - **`defineProps<{...}>()` / `defineEmits<{...}>()` 的字段**:从 script 段 TS AST 里的调用 + 泛型 type literal 成员抽(天然可得,无需 vue grammar)。
   - 行位置 = AST 内相对行 + script 块起始偏移 − 1(实测 99.9% 正确)。
2. **模板符号**(次要,增强):用 `tree-sitter-vue` grammar 抽 `<template>` 里的组件标签使用、事件绑定引用(99.5% 可靠)。0.5% 模板解析错的文件不影响脚本符号。
3. **落到 schema**:脚本符号 `language='vue'`、`file_path` 记 `.vue` 整文件相对路径、行号为整文件坐标;`extra` 里存 `is_script_setup`、`block='script'|'template'`。

## 对主计划的影响(已回写计划文件)

- Phase 1.4 `extractor/vue.ts` 明确为**混合式**(compiler-sfc 拆 script + vue grammar 读 template),不再依赖 vue grammar 抽脚本符号。
- **依赖新增**:包内需 `@vue/compiler-sfc`(纯 JS、体积小),与 `web-tree-sitter` + `tree-sitter-wasms` 并存。
- ParserBackend 抽象不变:vue 只是"先 host 侧拆块、再复用 TS/JS backend",不新增 grammar backend 分支。

## 复现

脚本:`.phase0-codegraph-probe/measure-vue.mjs`(`node measure-vue.mjs`)。
