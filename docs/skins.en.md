# Skins

[简体中文](skins.md) · [Manual](manual.en.md)

The same agent tree can wear different skins: palette, card surface, a banner on the header layer, icon,
frame (border / shadow), and capsule styling all come from one skin object. Three are built in; you can add your own.

![Three built-in skins: default / sakura / whale](assets/screenshot-skins.png?v=0.1.3)

## Built-in skins

| id | Name | Look |
|---|---|---|
| `default` | Default | follows the DSH theme (white card / dark card), touches no token |
| `sakura` | Sakura | pink surface + rose border/shadow, pink banner, redrawn sakura icon, level-2/3 dots turn pink/violet; **a whole sakura branch grows out of the top-left / bottom-left corner**, with a sprig on the capsule |
| `whale` | Whale girl | DeepSeek-blue surface + sea-gradient banner, redrawn whale icon, blue-tinted labels; **a baby whale peeks out of its splash at the top-right**, waves at the bottom-left |

Each skin carries its own dark values and follows DSH's `body[data-ds-dark-theme]` automatically:

![The three skins in dark mode](assets/screenshot-skins-dark.png?v=0.1.3)

## Switching

1. Expand the card and click the **paint-drop button** in the header (first of the three ghost buttons, left of the “—”);
2. A skin list opens under the header: the swatch shows its palette, the row shows name + one-line description,
   the active one has a ✓;
3. Click a skin to apply. The choice is stored in `localStorage: dsh-agent-tree:skin`;
4. The capsule keeps the skin too (the paint drop lives in the expanded header).

`Esc` or clicking the paint drop again closes the list.

## Decorations (decor)

A skin may also ship up to four **frame decorations**: images rendered outside the card, *behind* it, so only the parts
sticking out are visible — that is what makes the sakura branch / whale splash look like it grows out of the dock. When
collapsed, the first decoration is attached to the capsule's top-right corner.

Fields (CSS pixels, relative to the card's top-left corner; negative values stick out):

| Field | Meaning | Default |
|---|---|---|
| `src` | image: `data:image/png` / `webp` / `svg+xml`, or a built-in `key` (`sakura` / `whale`) | required |
| `x` / `y` | position; with `anchor: 'bottom'`, `y` means distance from the bottom | `0` |
| `w` | width (height follows) | `100` |
| `rot` | rotation (-60 … 60) | `0` |
| `opacity` | 0.15 … 1 | `1` |
| `flip` | mirror horizontally | `false` |
| `anchor` | `top` / `bottom` | `top` |

```js
window.__DSH_AGENT_TREE_SKINS__ = [{
  id: 'my-skin',
  decor: [
    { key: 'sakura', x: -56, y: -66, w: 158, rot: -20, opacity: 0.95 },
    { key: 'sakura', x: -40, y: -36, w: 108, rot: 170, flip: true, anchor: 'bottom' },
  ],
}];
```

Use only data URIs you trust — external `http` images are rejected on purpose (offline + safe).

## What a skin is

A skin is plain data (nothing is executed):

```js
{
  id: 'sakura',              // unique, a-z 0-9 -
  name: 'Sakura',
  desc: 'pink / rose accent', // optional
  icon: 'sakura',            // tree / sakura / whale / robot / clock, or your own iconSvg
  light: { /* light variables */ },
  dark:  { /* optional dark variables */ },
}
```

Every variable starts with `--dat-` and is applied on the plugin root. **Anything you omit falls back to the DSH
theme tokens**, so a 3-variable skin still works.

| Variable | Controls | Fallback |
|---|---|---|
| `--dat-surface` | card / skin-panel surface | `--dsw-alias-bg-layer-1` |
| `--dat-pill-bg` | collapsed capsule surface | same as `--dat-surface` |
| `--dat-head-bg` | header background (gradient allowed) | transparent |
| `--dat-banner` | banner overlay on the header (`background-image`) | none |
| `--dat-border` | borders and dividers | `--dsw-alias-border-l1/l2` |
| `--dat-shadow` | card / capsule shadow | `--dsw-elevation-panel` |
| `--dat-radius` | card radius | `14px` |
| `--dat-title` | header title / capsule name | `--dsw-alias-label-primary` |
| `--dat-sub` | secondary text / icon buttons | `--dsw-alias-label-secondary` |
| `--dat-muted` | tertiary text / chevron | `--dsw-alias-label-tertiary` |
| `--dat-icon` | header icon, accents | `--dsw-alias-label-secondary` |
| `--dat-chip` | capsule counter chips, hover tint | `--dsw-alias-interactive-bg-hover` |
| `--dat-hover` | row / button hover | `--dsw-alias-interactive-bg-hover` |
| `--dat-ok` | running-agent counter (`🤖N`) | `--dsw-alias-state-success-primary` |
| `--dat-dot-1` | top-level / running dot | `--dsw-alias-state-success-primary` |
| `--dat-dot-2` | level-2 subagent dot | `--dsw-alias-brand-primary` |
| `--dat-dot-deep` | level-3+ dots | `#8b5cf6` |
| `--dat-dot-idle` | idle / finished dot | `--dsw-alias-border-l3` |
| `--dat-wait` | “待答 / 待批 / 待审” text | `#d97706` |
| `--dat-wait-soft` | waiting badge background | `rgba(217,119,6,.14)` |
| `--dat-wait-border` | waiting badge border | `rgba(217,119,6,.33)` |

> Keep the semantic ones semantic: if `--dat-dot-1` (running) or `--dat-wait` (needs your call) blends into the
> surface, the at-a-glance read is gone.

## Add your own (DIY)

No source changes needed. Register from the DevTools console on the DSH page, then pick it from the skin list:

```js
window.__DSH_AGENT_TREE_SKINS__ = [
  {
    id: 'my-skin',
    name: 'My palette',
    desc: 'cream + gold',
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

- No restart: the card recomputes every second, so “My palette” shows up in the list right away;
- For something persistent, ship this snippet from your own client plugin / page script;
- Or edit the `SKINS` array in `client.js` — sakura and whale are ready-made templates;
- The selection lives in `dsh-agent-tree:skin`; pick `default` to follow the DSH theme again.

### icon and banner

- `icon`: `tree` (default) / `sakura` (five notched petals) / `whale` (round head + fluke + spout) / `robot` / `clock`; or pass `iconSvg: '<svg …</svg>'`
  to drop in your own monochrome SVG (it is placed in the 15px icon slot; only use SVGs you trust).
- banner: `--dat-banner` is a `background-image`; stack gradients (sakura does) or use `url(...)`.
- frame: `--dat-border` + `--dat-shadow` + `--dat-radius`. For a bolder border, add one CSS override:
  `[data-skin="your-id"] .dsh-agent-tree-card { border-width: 2px }`.

### Limits

- Values may not contain `; { } < > \` (to keep declarations from being closed early); overlong values are dropped;
- A skin only affects the plugin's own card / capsule;
- Duplicate ids: built-in skins win (`default` / `sakura` / `whale` cannot be overridden).
