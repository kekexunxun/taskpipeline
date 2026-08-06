// Stylelint flat config —— 使用 stylelint-config-standard + stylelint-config-recess-order。
// 项目使用 Tailwind v4 (`@import "tailwindcss"`, `@theme inline`, `color-mix()` 等)，
// 因此在 standard 基础上关停与 Tailwind 指令 / 自定义属性 / 现代 CSS 特性冲突的规则。
/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard', 'stylelint-config-recess-order'],
  // 默认扩展 *.css、*.scss、*.less；本仓库目前只用到 CSS
  customSyntax: undefined,
  ignoreFiles: [
    '**/node_modules/**',
    '**/dist/**',
    '**/dist-electron/**',
    '**/release/**',
    '**/.vite/**',
    '**/coverage/**',
    // Tailwind / 第三方 shim 样式不参与规则校验
    'apps/desktop/dist/**',
    '**/vendor/**'
  ],
  rules: {
    // —— Tailwind v4 指令白名单 ——
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: [
          'theme',
          'apply',
          'variants',
          'responsive',
          'screen',
          'layer',
          'config',
          'plugin',
          'source',
          'utility',
          'custom-variant',
          'reference',
          'tailwind',
          'tailwindcss',
          'variant',
          'slot',
          'utility'
        ]
      }
    ],

    // —— 现代 CSS / Tailwind 兼容项 ——
    // Tailwind v4 使用 `@import "tailwindcss";` 字符串语法（非 url）
    'import-notation': null,
    // utility class 与多变体并存，特异性排序交给 Tailwind
    'no-descending-specificity': null,
    // Tailwind 生成的工具类不受我们控制
    'selector-class-pattern': null,
    // 业务样式里有大量 keyframes/动画块，关闭空行规则
    'comment-empty-line-before': null,
    'declaration-empty-line-before': null,
    'rule-empty-line-before': null,
    'at-rule-empty-line-before': null,
    // 关闭 Pseudo-class 变体导致的"重复"误报
    'no-duplicate-selectors': null,
    // 接受现代 CSS 语法糖
    'alpha-value-notation': null,
    'color-function-notation': null,
    'media-feature-range-notation': null,
    'selector-not-notation': null,
    // keyframe 名称混用大小写在项目里已有先例
    'value-keyword-case': null,
    'keyframes-name-pattern': null,
    // Tailwind 兼容 shorthand
    'shorthand-property-no-redundant-values': null,
    'declaration-block-no-redundant-longhand-properties': null,
    'declaration-block-no-shorthand-property-overrides': null,
    // `--tw-*` 私有变量定义必须保留，即使其他位置已用 `--tw-` 形式出现
    'custom-property-pattern': null,
    // 允许内联 --tw-* 变量与 calc() / var() 链式调用
    'declaration-block-no-duplicate-properties': [true, { ignore: ['consecutive-duplicates-with-different-values'] }],
    // 设计系统使用双位数 px/spacing，关闭长度单位严格性
    'length-zero-no-unit': null,
    // 允许全局 reset 使用 `*` 通用选择器
    'selector-nested-pattern': null,
    // 关闭“必须以小写命名 keyframe”这类风格规则
    'function-name-case': null,
    // 业务里有大量 0.X 形式小数
    'number-max-precision': null,
    // `--tw-enter-opacity: 0;` 这类数字字面量我们保留原样
    'declaration-property-value-allowed-list': null,
    'declaration-property-value-disallowed-list': null
  }
}
