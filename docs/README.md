# fx-tui 介绍页（本地预览 / 发布说明）

`docs/` 同时是 GitHub Pages 的发布目录。这个页面是**纯静态**的：一个
`index.html` + 一份 `style.css` + 一个小脚本，没有构建、没有外部字体、没有运行时依赖。

## 本地预览

在仓库根目录：

```sh
python3 -m http.server 8791 --directory docs
# 打开 http://127.0.0.1:8791/
```

直接双击 `docs/index.html` 也能看，但用本地服务器更接近线上（相对路径、剪贴板权限）。

## 改哪里

| 想改 | 文件 |
|---|---|
| 文案、区块顺序、安装命令 | `index.html` |
| 颜色 token、点阵、字号、响应式 | `style.css`（前半段 `:root` 是全部 token） |
| 导航吸顶、入场动画、复制按钮 | `app.js`（一般不用动） |
| 界面截图 | `assets/shot-light.webp`（1448×1642） |
| 分享图（1200×630） | `og.png` |
| 图标 | `assets/icon.svg` |

发布前记得同步把 `index.html` 里的 `v0.36.0` 改成当前版本（导航、Hero 的
eyebrow、页脚三处），以及 `package.json`、`og.png` 对应的版本变化。

## 发布到 GitHub Pages（部署时才做）

1. 合并到 `main`，确认 `docs/index.html` 在仓库里。
2. 仓库 Settings → Pages → Deploy from a branch → `main` / `/docs`。
3. 用 API：
   ```sh
   gh api --method POST repos/xianglifei/dsh-tui-fx/pages --input - <<'JSON'
   {"source":{"branch":"main","path":"/docs"}}
   JSON
   ```
4. 仓库 About → Website 填 `https://xianglifei.github.io/dsh-tui-fx/`。
5. 等构建完成（`gh api repos/xianglifei/dsh-tui-fx/pages` 变 `built`，URL 返回 200），
   再用真实 URL 跑一遍验收：320 / 390 / 768 / 1024 / 1440 宽度、导航两态、无 JS、无 404。
6. 最后在根 `README.md` 顶部加一行线上地址，别在 404 时先写链接。

`.nojekyll` 已经在目录里，避免 Jekyll 处理。

## 设计来源

沿用 `dsh-plugin-site` 技能的单页结构：点阵画布 + 实心导航 + 14px 浮起白卡，
视觉 token 取自 fx-tui 自己的界面域（teal-cyan）。终端画面用亮色终端的配色
（白底、深 teal、可读性达标的绿色/琥珀/红色），与站点同一底色，不使用深色版本。
