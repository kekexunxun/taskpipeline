// 简单 helper，渲染端所有 API 调用都走 window.agentApi（由 preload 注入）
// 浏览器回退模式下 api 对象自带 mock 数据，所以这里不需要再包一层
export {}; // 模块占位
