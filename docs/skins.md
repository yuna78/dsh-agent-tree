# 皮肤（Skin）

简体中文 · [English](skins.en.md) · [使用手册](manual.md)

同一棵 agent 树，可以换不同的「皮肤」：配色、卡片背景、标题层的 banner、icon、边框 / 阴影（frame）、胶囊样式，
以及**长在卡片外面的插画装饰**（QQ 皮肤那种「dock 外面冒出来一圈」），都由一套皮肤决定。内置六套（三套配色 + 三套手绘插画风），也可以自己加。

![六套内置皮肤：默认 / 樱花 / 鲸鱼娘 / 鲸鱼娘·小姑娘 / 竹林 / 兰花](assets/screenshot-skins.png?v=0.1.4)

## 内置皮肤

| id | 名字 | 样子 |
|---|---|---|
| `default` | 默认 | 跟随 DSH 主题（浅色白卡 / 深色深灰卡），不改任何 token |
| `sakura` | 樱花 | 粉白卡面 + 樱色边框 / 阴影，标题层粉色 banner，重画的樱花 icon，第 2/3 层圆点转粉 / 紫；**一整枝樱花从卡片左上角 / 左下角长出来**，胶囊上也贴着小枝 |
| `whale` | 鲸鱼娘 | DeepSeek 蓝卡面 + 海面渐变 banner，重画的鲸鱼 icon，模型标签 / 计数偏蓝；**浪花里的小鲸鱼从卡片右上角探出来**，左下角有浪花 |
| `whale-girl` | 鲸鱼娘·小姑娘 | 天蓝 + 淡粉 banner，手绘 Q 版小姑娘（双马尾 + 鲸鱼尾巴发饰 + 水手领）**从卡片右上角探出头来**，胶囊上也有她 |
| `bamboo` | 竹林 | 水彩翠竹 + 竹叶留白，草绿 banner；**两丛竹子从卡片右侧 / 左侧长出来**，叶子伸到框外 |
| `orchid` | 兰花 | 淡紫兰草 + 粉调 banner，暗紫文字；**一丛兰花从卡片右上角探出、一丛从左下角长出来** |

深色模式下每套皮肤都有自己的暗色变量，自动跟随 DSH 的 `body[data-ds-dark-theme]`：

![深色模式下的六套皮肤](assets/screenshot-skins-dark.png?v=0.1.4)

## 怎么换

1. 展开卡片，点窗口头右侧的**小 T 恤按钮**（三个 ghost 按钮里的第一个，在「—」左边）；
2. 标题层下面会展开皮肤列表：左边色块是这套皮肤的配色，右边是名字和一句话说明，当前这套带 ✓；
3. 点一套即生效，选择存在 `localStorage: dsh-agent-tree:skin`，下次打开还是它；
4. 收起成胶囊后皮肤照样生效（胶囊里没有换肤入口，展开就能换），第一张外框装饰会贴到胶囊右上角。

按 `Esc` 或再点一次小 T 恤可以关掉列表。切换时会重建一条只属于皮肤变量的 `<style>`，不写进 DSH 自己的 token。

## 外框装饰（decor）

每一套皮肤还可以带最多 4 张**外框装饰**：图片渲染在卡片外层、卡片**后面**，只有伸出框外的部分看得见，
所以看起来像从 dock 边缘长出来（樱花枝、鲸鱼浪花、小姑娘、竹子、兰花都是这么做的）。收起成胶囊时，会用第一张装饰贴到胶囊右上角。

装饰项字段（单位都是 CSS 像素，相对卡片左上角；负值就是冒出框外）：

| 字段 | 含义 | 默认 |
|---|---|---|
| `src` | 图片：`data:image/png` / `webp` / `svg+xml`，或内置素材 `key`（`sakura` / `whale` / `whaleGirl` / `bamboo` / `orchid`） | 必填 |
| `x` / `y` | 位置；`anchor: 'bottom'` 时 `y` 变成距底距离 | `0` |
| `w` | 宽度（高度按比例） | `100` |
| `rot` | 旋转角度（-60 ~ 60 度） | `0` |
| `opacity` | 不透明度（0.15 ~ 1） | `1` |
| `flip` | 水平镜像 | `false` |
| `anchor` | `top`（默认）/ `bottom` | `top` |

```js
window.__DSH_AGENT_TREE_SKINS__ = [{
  id: 'my-skin',
  decor: [
    { key: 'sakura', x: -56, y: -66, w: 158, rot: -20, opacity: 0.95 },
    { key: 'sakura', x: -40, y: -36, w: 108, rot: 170, flip: true, anchor: 'bottom' },
  ],
}];
```

> 装饰图会原样塞进 `<img src>`；只放你自己信得过的 data URI，不要引用外部 http 图片（既不安全也不离线可用）。

## 一套皮肤长什么样

皮肤就是一个纯数据对象（不执行代码）：

```js
{
  id: 'sakura',              // 唯一 id，只允许 a-z 0-9 -
  name: '樱花',              // 换肤列表里显示的名字
  desc: '粉白 · 樱色点缀',    // 一句话说明（可省略）
  icon: 'sakura',            // 树 / 樱花 / 鲸鱼 / 机器人 / 时钟，或自己给 iconSvg
  light: { /* 浅色变量 */ },
  dark:  { /* 深色变量，可省略 */ },
}
```

所有变量都以 `--dat-` 开头，挂在插件根节点上；**没写的变量自动回落到 DSH 主题令牌**，
所以「只写三个变量」的皮肤也能用。

| 变量 | 管什么 | 不写时回落 |
|---|---|---|
| `--dat-surface` | 卡片 / 皮肤面板底色 | `--dsw-alias-bg-layer-1` |
| `--dat-pill-bg` | 收起后胶囊的底色 | 同 `--dat-surface` |
| `--dat-head-bg` | 标题层背景（可以是渐变） | 透明 |
| `--dat-banner` | 标题层上的 banner 叠加层（渐变 / 图形，`background-image`） | 无 |
| `--dat-border` | 边框、分隔线 | `--dsw-alias-border-l1/l2` |
| `--dat-shadow` | 卡片 / 胶囊阴影（frame 的一部分） | `--dsw-elevation-panel` |
| `--dat-radius` | 卡片圆角 | `14px` |
| `--dat-title` | 标题、胶囊名字 | `--dsw-alias-label-primary` |
| `--dat-sub` | 次要文字 / 图标按钮 | `--dsw-alias-label-secondary` |
| `--dat-muted` | 三级文字 / 展开箭头 | `--dsw-alias-label-tertiary` |
| `--dat-icon` | 标题 icon、强调色 | `--dsw-alias-label-secondary` |
| `--dat-chip` | 胶囊计数 chip、hover 底衬 | `--dsw-alias-interactive-bg-hover` |
| `--dat-hover` | 行 / 按钮 hover 底色 | `--dsw-alias-interactive-bg-hover` |
| `--dat-ok` | 在跑 agent 计数（`🤖N`）的颜色 | `--dsw-alias-state-success-primary` |
| `--dat-dot-1` | 顶层对话 / 在跑圆点 | `--dsw-alias-state-success-primary` |
| `--dat-dot-2` | 第 2 层 subagent 圆点 | `--dsw-alias-brand-primary` |
| `--dat-dot-deep` | 第 3 层及更深圆点 | `#8b5cf6` |
| `--dat-dot-idle` | 空闲 / 已结束圆点 | `--dsw-alias-border-l3` |
| `--dat-wait` | 「待答 / 待批 / 待审」文字色 | `#d97706` |
| `--dat-wait-soft` | 待办小徽章底色 | `rgba(217,119,6,.14)` |
| `--dat-wait-border` | 待办小徽章描边 | `rgba(217,119,6,.33)` |

> 语义色建议保留：`--dat-dot-1`（在跑）和 `--dat-wait`（等你拍板）如果换成和背景接近的颜色，一眼判断就没了。

## 自己加一套（DIY）

不用改插件源码。在 DSH 页面的 DevTools 控制台里注册，然后从皮肤列表里选：

```js
window.__DSH_AGENT_TREE_SKINS__ = [
  {
    id: 'my-skin',
    name: '我的配色',
    desc: '淡粉 + 金',
    icon: 'sakura',
    light: {
      '--dat-surface': '#fffdf6',
      '--dat-head-bg': 'linear-gradient(135deg,#ffe9f2 0%,#fff8ec 100%)',
      '--dat-banner': 'radial-gradient(circle at 80% -10%,rgba(244,114,182,.28),transparent 60%)',
      '--dat-border': 'rgba(234,179,8,.38)',
      '--dat-title': '#9d174d',
      '--dat-icon': '#d97706',
      '--dat-chip': 'rgba(253,230,138,.5)',
      '--dat-hover': 'rgba(253,230,138,.35)',
    },
    dark: {
      '--dat-surface': '#221a12',
      '--dat-title': '#fde68a',
      '--dat-border': 'rgba(234,179,8,.3)',
    },
  },
];
```

- 注册后**不用重启**：卡片每秒会重算一次，皮肤列表里直接出现「我的配色」，点它就换上了；
- 想长期生效，把这段放进自己的客户端插件 / 页面脚本（在卡片挂载前后都行）；
- 也可以直接改 `client.js` 里的 `SKINS` 数组——内置六套就是现成模板；
- 选择状态存 `dsh-agent-tree:skin`，换成 `default` 就回到跟随主题。

### icon 与 banner

- `icon`：`tree`（默认树）/ `sakura`（带缺口的 5 瓣樱花）/ `whale`（圆头 + 尾鳍 + 喷水）/ `whale-girl`（小姑娘头像）/ `bamboo`（竹竿 + 竹叶）/ `orchid`（五瓣兰） / `robot` / `clock`；也可以写 `iconSvg: '<svg …</svg>'` 直接塞自己的单色 SVG（会被放进 15px 的图标位；只放你自己信得过的 SVG）。
- banner：`--dat-banner` 是 `background-image`，可以叠多层渐变（上面樱花就是这样做的）；想放图片就写 `url(...)`。
- frame：`--dat-border` + `--dat-shadow` + `--dat-radius` 三件套；想做成「粗描边贴纸风」就把 border 加粗（值里写 `2px solid …` 不行——`--dat-border` 只放颜色，宽度写死在 CSS 里；需要更夸张的边框可以再加一条 CSS 覆盖 `[data-skin="你的id"] .dsh-agent-tree-card { border-width: 2px }`).

### 限制

- 变量的值不能包含 `; { } < > \`（防止把声明提前闭合），超长值也会被截断；
- 皮肤只影响卡片 / 胶囊自己的观感，不改 DSH 其它区域；
- id 重复时以内置皮肤为准（DIY 不能顶掉 `default` / `sakura` / `whale` / `whale-girl` / `bamboo` / `orchid`）；
- 装饰图最多 4 张，单张 data URI 不超过 400KB，越出边界的坐标会被夹回范围（防止把卡撑出屏幕）。
