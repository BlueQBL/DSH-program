# assets —— 图片放这里

## 首屏头像

| 文件 | 作用 |
| --- | --- |
| `avatar.jpg` | **默认头像**。1080×1080 的实拍照片，首屏直接用它。 |
| `avatar-line-art.svg` | 线描兜底图。只在 `avatar.jpg` 缺失 / 加载失败时顶上，也适合当你不想放真人照片时的替代。 |

换成别的照片，有两条路：

### 路线一：网页上直接换（不用碰代码）

首屏头像下面就有 **「上传照片」** 按钮：

1. 点它选一张本地图片；
2. 浏览器里会先缩到长边 ≤ 1200px 再转成 JPEG，然后存进这台机器的 `localStorage`；
3. 刷新后自动恢复，旁边会出现 **「恢复默认」** 用来退回 `avatar.jpg`。

**照片不会离开你的浏览器**——这个站没有后端，也没有任何上传接口。

### 路线二：换掉默认那张（跟着仓库走，换电脑也在）

把新照片放进这个目录，替换 `avatar.jpg` 即可。尺寸建议 **1:1、≥ 800×800**。

想用别的文件名或格式，就改 `index.html` 里那一处：

```html
<img class="portrait__photo" src="./assets/avatar.jpg" ... />
```

同时记得把 `onerror` 里的兜底路径和 `main.js` 里的 `DEFAULT_PHOTO` 一起改掉。

### 关于亮底照片

白底 / 亮底照片放进深色页面会变成一块亮斑，所以头像四边有一层很轻的内描边
（`box-shadow: inset`）把它收进"工作台"的框里——**只压边缘，不改变照片本身**。
取景用 `object-fit: cover` + `object-position: 50% 35%`（人像通常头顶留白多）；
想微调就改 `styles.css` 里 `.portrait__photo` 这一处。

## `shots/` —— 项目截图

现在是空的，**这是故意的**：6 张项目缩略图默认由 `main.js` 里的内联 SVG 画出来
（每个项目按它自己的视觉母题手绘，比如流水账是热敏小票、水尺是刻度柱）。

想换成真实截图，只要把图丢进来、命名对上就行，**不需要改任何代码**：

```
assets/shots/
├── image-compressor.png     ← main.js 里 p.shot 指的就是这个路径
├── ledger.png
├── water-reminder.png
├── werewolf-game.png
├── jwt-auth.png
└── react-router.png
```

命名规则：`main.js` 中每个项目的 `shot` 字段。图片加载失败时，`onerror` 会自动
回落到 SVG，所以**放一半也不会开天窗**——这个回落逻辑有测试覆盖
（`npm run smoke` 里的"缩略图都有内容"）。

推荐尺寸 16:10（例如 1280×800），深色界面截图最好，和卡片底色的过渡更自然。
