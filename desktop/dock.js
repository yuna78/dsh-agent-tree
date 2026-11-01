/**
 * dsh-plugin-agent-tree · 桌面壳渲染层（dock.js）
 *
 * 页面里跑的就是 client.js 那套 MiniInner（与 DSH 页内卡片同一组件、同一皮肤），
 * dock.js 只做五件壳才能做的事：
 *   1. 应用主题：亮/暗 + DSH 主题 token（浏览器端随快照发来），保证和页内同色；
 *   2. 上报布局：卡片/胶囊矩形 → 原生层做点击穿透；内容外沿 → 原生层定窗口尺寸；
 *   3. 窗口拖动：拦下 MiniInner 的页内拖动，把位移交给原生层挪整个窗口；
 *   4. 右键菜单：打开 DSH / 复位位置 / 退出浮窗；
 *   5. 点行跳转：发给原生层 → 宿主排队 → 浏览器端 openSession。
 *
 * 零网络：数据由原生层注入 window.__dockState()（base64 解一层，避开 shell 转义问题）。
 */
(function () {
  'use strict';

  const client = window.__DSH_AGENT_TREE_CLIENT__;
  if (!client || !client.__test) {
    document.body.textContent = 'client.js 没加载起来（桌面壳文件不全，重新 npm run dock:build）';
    return;
  }
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const { MiniInner, ensureStyles, ensureSkinStyles } = client.__test;
  const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dock;
  const send = (message) => {
    try {
      if (native) native.postMessage(message);
    } catch (err) {
      /* 桥断了就静默：页面还能照常渲染 */
    }
  };

  // 与 dock.css 里的留白保持一致；原生窗口尺寸 = 内容外沿 + 这圈留白。
  const PAD_LEFT = 130;
  const PAD_TOP = 150;
  const PAD_BOTTOM = 44;

  ensureStyles();
  ensureSkinStyles();

  // MiniInner 只在挂载时读一次 localStorage；给它一个和 CSS 钉位一致的值，
  // 万一 CSS 没生效（老 WebKit），位置也不会跑到屏幕外。
  try {
    window.localStorage.setItem('dsh-agent-tree:pos', JSON.stringify({ x: PAD_LEFT, y: PAD_TOP }));
  } catch (err) {
    /* file:// 下 localStorage 可能被禁：有 CSS 钉位兜底 */
  }

  // ------------------------------------------------------------ 状态注入与渲染

  let state = null;
  let root = null;
  const mount = document.getElementById('mount');

  function setOffline(offline) {
    if (document.body.classList.contains('is-offline') === offline) return;
    document.body.classList.toggle('is-offline', offline);
  }

  function applyTheme(payload) {
    const dark = payload && payload.theme === 'dark';
    if (dark) document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
    const tokens = (payload && payload.tokens) || {};
    for (const name of Object.keys(tokens)) {
      const value = tokens[name];
      if (typeof value === 'string' && value !== '') document.body.style.setProperty(name, value);
    }
  }

  /** 宿主发来的 statuses 是 [id, status] 数组（JSON 没有 Map），还原成 Map。 */
  function reviveStatuses(entries) {
    const map = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') {
        map.set(entry[0], entry[1]);
      }
    }
    return map;
  }

  function render() {
    if (!state || !state.tree || typeof state.tree !== 'object') return;
    applyTheme(state);
    if (!root) root = ReactDOM.createRoot(mount);
    root.render(
      React.createElement(MiniInner, {
        tree: state.tree,
        mode: state.mode === 'live' ? 'live' : 'poll',
        processes: Array.isArray(state.processes) ? state.processes : [],
        instances: Array.isArray(state.instances) ? state.instances : [],
        sessions:
          state.sessions && typeof state.sessions === 'object' ? state.sessions : { ids: [], byId: {} },
        statuses: reviveStatuses(state.statuses),
        onOpen: (id) => send({ type: 'open', id }),
      }),
    );
    setOffline(false);
  }

  /** 原生层入口：直接注入 JSON（本页内部使用）。 */
  window.__dockState = (payload) => {
    if (payload === null || typeof payload !== 'object') return;
    state = payload;
    render();
  };

  /** 原生层实际调用的入口：base64 包一层，避免 shell 拼字符串时的转义问题。 */
  window.__dockStateB64 = (encoded) => {
    try {
      const binary = window.atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      window.__dockState(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (err) {
      /* 坏帧直接丢掉，下一秒会有新帧 */
    }
  };

  /** 原生层轮询失败够多次时调用：卡片变暗 + 提示。 */
  window.__dockOffline = () => setOffline(true);

  // ------------------------------------------------------------ 布局上报

  let lastLayout = '';
  const inset = (rect, padding) => ({
    x: Math.round(rect.left - padding),
    y: Math.round(rect.top - padding),
    w: Math.round(rect.width + padding * 2),
    h: Math.round(rect.height + padding * 2),
  });

  function reportLayout() {
    const rootEl = mount.firstElementChild;
    if (!rootEl) return;
    const target =
      rootEl.querySelector('.dsh-agent-tree-card') || rootEl.querySelector('.dsh-agent-tree-pill');
    if (!target) return;
    const cardRect = target.getBoundingClientRect();
    if (cardRect.width < 8) return;

    // 可点区域 = 卡片/胶囊本体（皮肤菜单、更新面板都在卡片里面）；装饰伸出去的部分点击穿透。
    const hit = [inset(cardRect, 2)];

    // 可拖区域：展开时是卡片头部，收起时是整个胶囊（原生拖动条接管，不依赖页面 JS）。
    const handle = rootEl.querySelector('.dsh-agent-tree-head') || rootEl.querySelector('.dsh-agent-tree-pill');
    const drag = handle === null ? null : inset(handle.getBoundingClientRect(), 0);
    // 头部里的按钮要留给网页（换肤 / 检查更新 / 最小化）：在拖区上报成「洞」。
    const holes = [];
    for (const button of rootEl.querySelectorAll('.dsh-agent-tree-head button')) {
      const rect = button.getBoundingClientRect();
      if (rect.width > 0) holes.push(inset(rect, 0));
    }

    // 内容外沿（含伸出去的装饰）决定原生窗口要多大；窗口宽固定，高度取内容最下沿。
    let right = cardRect.right;
    let bottom = cardRect.bottom;
    for (const decor of rootEl.querySelectorAll('.dsh-agent-tree-decor')) {
      const rect = decor.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) continue;
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    const size = { w: Math.ceil(right + 24), h: Math.ceil(bottom + PAD_BOTTOM) };
    const layout = JSON.stringify({ hit, size, drag, holes });
    if (layout === lastLayout) return;
    lastLayout = layout;
    send({ type: 'layout', hit, size, drag, holes });
  }

  // 装饰图片是异步解码的 data URL，渲染完立刻量可能量小了；
  // 用一个低频循环把「迟到」的布局补上报（内容不变时发出去的也会被去重）。
  window.setInterval(reportLayout, 400);
  window.addEventListener('resize', reportLayout);

  // ------------------------------------------------------------ 点击注入

  // 拖动条的鼠标按下由原生层接管（见 dock.swift 的 performDrag）：
  // 轻点一下（没有移动窗口）时，原生层回调这里，把 click 还给页面。
  window.__dockTapAt = (x, y) => {
    const target = document.elementFromPoint(x, y);
    if (target === null) return;
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  };

  // ------------------------------------------------------------ 启动

  // 页面就绪：原生层这才注入第一帧状态（比 evaluateJavaScript 撞加载时序可靠）。
  send({ type: 'ready' });
  requestAnimationFrame(reportLayout);
})();
