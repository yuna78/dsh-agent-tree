# vendor/

桌面壳渲染页需要的 React 运行时（UMD 生产构建，React 18.3.1）：

- `react.js` / `react-dom.js` — Facebook 官方 `react.production.min.js` / `react-dom.production.min.js`，
  文件头部自带 `@license React` 与 MIT 声明；源码来自 npm 包 `react@18.3.1` / `react-dom@18.3.1`。
- client.js 的模块加载器只 `require('react')`，所以只需这两份运行时，无其它第三方依赖。

为什么打进包里：桌面壳（`desktop/dock.swift`）的 WKWebView 加载的是本地 `file://` 页面，
按隐私约定**全程零网络**，不能也不应该去 CDN 拉 React。两份文件合计约 140 KB。
