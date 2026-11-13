# dsh 基座升级清单

fx-tui 是 dsh 的树外 bundle，**类型面必须与 host 同版本**。这份清单是每次
基座升级的固定动作，按顺序做，别跳步。最近一次执行：`0.1.5-rc.2 →
0.2.2-rc.1`（v0.36.0，2026-11-13），历史调研见
[dsh-0.1.2-alpha-upgrade-notes.md](dsh-0.1.2-alpha-upgrade-notes.md)。

## 什么时候该动

- `dsh --version` 变了，且启动时出现这行 warning：

  ```text
  dsh: skipping profile bundle "fx-tui": Error: Plugin fx-tui@x.y.z is incompatible with dsh <版本>
  ```

  这不是 bug：fx-tui 的 `peerDependencies` 精确锁 dsh 版本，dsh 0.2 起会在装配
  profile 时校验，不一致就**跳过整个 bundle**，免得 TUI 带着未知运行时跑。
- 上游发 rc/stable 且本机 host 已升（或你打算升）。

## 一、升级前（不可省）

```sh
cp -R ~/.dsh/sessions ~/.dsh/sessions.bak-$(date +%F)   # 会话格式迁移的保险
git tag vX.Y.Z                                          # 回滚锚点（当前发布版本）
```

会话日志是 v0→v4 逐级迁移的：新版打开旧会话时会**旁生成**一个
`session.v4.jsonl.zstd`，原文件保留，所以历史可读可回滚；但**升级后新建的会话
只有新格式文件，旧基座读不了**。备份是唯一保险。

## 二、探针：先量断点，再动代码

不要直接 `pnpm install` 一把梭。在仓库副本里只换依赖、跑一次类型检查，拿到
真实断点清单：

```sh
cp -R <repo> /tmp/dsh-probe && cd /tmp/dsh-probe
# 把 package.json 的 19 个 devDeps / 3 个 peers / cordis 一起改到目标版本
pnpm install
pnpm typecheck          # 这一步的错误清单就是迁移工作量
```

同时按包 diff 导出面（`.d.ts` 的 `export` 集合）能快速区分「编译期就炸」与
「能编译但语义变了」两类变更——后者才是升级的主要风险，0.2.2 那次的工具结果
与模型选择都属于后者。

## 三、固定动作

1. `package.json`：19 个 `@deepseek-ai/dsh-*` devDeps、3 个 peerDeps 全部提到
   目标版本；cordis 跟基座的 peer 要求（`~4.1.0` 起）。
2. **peers 保持精确版本**，不要改成范围：范围会让不匹配的基座"带病启动"，
   精确锁让它在装配阶段就拒绝并打一行看得见的 warning。
3. `engines.node` 跟基座：dsh 0.2.2 起要求 `>=24.9.0`。
4. `.github/workflows/ci.yml` 的 Node 版本同步（否则 CI 的 typecheck 直接红）。
5. `pnpm install` 重生成 lockfile，确认 `pnpm install --frozen-lockfile` 可装。
6. 代码迁移按断点逐条改（迁移与依赖升级**同一个 PR**：只升依赖会让 CI 红）。
7. 文档：`docs/install.md` 的 Node/dsh 下限、`README` 如有版本表述。
8. 发版：`FX_TUI_VERSION`、`package.json` version、本文件补一次执行记录。

## 四、升级后验证

按代价从低到高，任何一层红了就停：

| 层 | 命令/动作 | 判据 |
|---|---|---|
| L0 | `pnpm lint && pnpm typecheck && pnpm run build` | 0 error |
| L1 | `pnpm test` | 全绿（0.2.2 那次 368 用例） |
| L2 | `pnpm build && node scripts/replay-session.mjs test/fixtures/session-logs/<name>.jsonl` | 与同名 `.expected.json` 一致；`pnpm test` 已含这一层 |
| L3 | `scripts/tui-stability-matrix.sh` | 既有 4 条不变量不退化 |
| L4 | 手工冒烟：发消息流式 → 工具卡片 → 审批卡 → 提问卡 → 运行中 Tab 排队两条 + Alt+↑ 取回一条 → `/model` 切换后发一条消息 → `/status` → `/cost` → `/tree` → `/export`（有系统提示词或工具变更时看两个附录）→ Ctrl+C 两次 | 每项符合预期，`/model` 后请求头与状态栏一致 |
| L5 | `--resume` 一个旧版本会话 | banner、`/tree`、`/export` 正常；日志里仍有 pending inbox 时托盘要显示（0.37.0+） |

L3/L4 必须在真终端里做（`tmux`/`script` 都行）；CI 只能覆盖 L0–L1。

## 五、回滚

```sh
npm i -g @deepseek-ai/dsh@<旧版本>
git checkout v<上一个 tag> && pnpm install && pnpm run build
dsh plugin --profile fx add "$(pwd)"     # 重装 profile，别只重装 CLI
```

再恢复第一步的会话备份。回滚只能找回升级前的历史；升级后新建的会话在新格式里，
旧基座读不了。

## 六、执行记录

| 日期 | 迁移 | 断点 | 关键变化 |
|---|---|---|---|
| 2026-11-13 | `0.1.5-rc.2 → 0.2.2-rc.1`（cordis `4.0.2 → ~4.1.0`，Node `>=24.9.0`） | 10 个编译错误 / 2 类 API | 插件版本门禁；模型选择改会话日志事实；工具结果改一等公民 `tool` 消息；会话格式 v0→v4 |
