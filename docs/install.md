# fx-tui 安装指南

fx-tui 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的树外 bundle 插件。装好它一共涉及四件事：

- Node.js >= 24.9.0 和 pnpm（dsh 0.2.2 起硬要求 Node 24.9）
- DeepSeek Harness 本体（dsh CLI）0.2.2-rc.1 或更高 —— fx-tui 的运行时依赖，没有它无法启动
- DeepSeek API key（去 [platform.deepseek.com](https://platform.deepseek.com) 申请）
- 克隆并构建 fx-tui，注册为 dsh 的 fx profile

最省事的用法：回到 [README 的「安装」一节](../README.md#安装)，把那句话复制给任意终端编码 agent，它会读取本页并自动完成全部步骤。下面的内容也可以人工逐步执行或排查问题。

## 交给 Agent 一键安装（推荐）

把下面这段 Prompt 复制给任意终端编码 agent（Claude Code、ZCode 等）即可：

```text
帮我安装 fx-tui——DeepSeek Harness（dsh）的交互式终端界面（一个树外 bundle 插件）。

仓库地址：https://github.com/xianglifei/dsh-tui-fx

请严格按以下顺序执行，每一步完成后再进行下一步；任何一步失败就停下，
把错误原文完整告诉我，不要自行猜测或跳过：

1. 检查并安装 Node.js >= 24.9.0（fx-tui 和 dsh 都依赖它）：
   node --version
   若未安装或版本过低：macOS 用 brew install node@24（或用 nvm install 24），
   Linux 用系统包管理器或 nvm；装完重开 shell 再验证一次。

2. 检查并安装 pnpm：
   pnpm --version
   若未安装：corepack enable（Node 自带）或 npm install -g pnpm。

3. 检查并安装 DeepSeek Harness 本体（dsh CLI）：
   dsh --version
   若未安装：npm install -g @deepseek-ai/dsh，装完再跑一次 dsh --version 确认
   版本不低于 0.2.2-rc.1。这是 fx-tui 的运行时本体，没有它 fx 无法启动。
   注意：dsh 目前以 rc 预发布版滚动发布（如 0.2.2-rc.1），按 semver 规则
   rc 版小于同号正式版属正常现象，不要因 -rc 后缀判定"版本不满足"而中止，
   也不要自行放宽或收紧版本条件。

4. 检查并配置 DeepSeek API key：
   读取 ~/.dsh/.credentials.yaml，确认包含 DEEPSEEK_API_KEY 一行。
   若文件或该行不存在：提醒我先去 https://platform.deepseek.com 申请密钥，
   然后替我创建（mkdir -p ~/.dsh，写入 DEEPSEEK_API_KEY: sk-xxx，
   并 chmod 600 ~/.dsh/.credentials.yaml）。

5. 安装 fx-tui（npm 正式包，两条命令）：
   npm install -g dsh-tui-fx      # 提供 fx 命令
   dsh plugin --profile fx add dsh-tui-fx   # 注册为 dsh 的 fx profile
   安装时若提示 missing peer @deepseek-ai/*，可忽略（这些包由 dsh 本体提供）。

   若 npm 不可用（网络/私服），退回源码安装：
   git clone https://github.com/xianglifei/dsh-tui-fx.git ~/fx-tui
   cd ~/fx-tui && pnpm install && pnpm run build
   dsh plugin --profile fx add "$(pwd)"
   macOS：cp bin/fx /opt/homebrew/bin/fx
   Linux：sudo cp bin/fx /usr/local/bin/fx

6. 验证，把每条命令的实际输出告诉我：
   fx --help     # 应输出 fx-tui 的帮助与版本号（若提示 dsh 未安装或 profile
                 # 未装，说明第 3/5 步没成功，回到对应步骤排查）
   fx            # 应进入交互式界面；输入 /status 可查看运行状态；
                 # 按 Ctrl+C 两次退出

全部通过后告诉我 fx 已就绪，并提示我用 fx --help 查看用法。
```

## 基座版本必须与 fx-tui 对齐

fx-tui 的 `peerDependencies` 精确锁定 dsh 版本（当前 `0.2.2-rc.1`）。dsh 启动时会校验这组
版本：不一致就打印一行 `skipping profile bundle "fx-tui"` 并**跳过整个 TUI**，而不是带病运行
—— 看到这行警告说明该升级 fx-tui 了。升级动作、验证项与回滚步骤见
[dsh 基座升级清单](dsh-upgrade-checklist.md)。

## 手动安装（备查）

**第 1 步：安装 DeepSeek Harness 本体（dsh）。** fx-tui 是 dsh 的插件，
没有 dsh 就无法运行——这是最容易被忽略的一步：

```sh
node --version          # 需 >= 24.9.0；没有先装 Node.js
npm install -g @deepseek-ai/dsh
dsh --version           # 确认 >= 0.2.2-rc.1（dsh 目前均为 rc 预发布版，属正常）
```

**第 2 步：配置 DeepSeek API key**（没有的话去
[platform.deepseek.com](https://platform.deepseek.com) 申请）：

```sh
mkdir -p ~/.dsh
cat > ~/.dsh/.credentials.yaml << 'EOF'
DEEPSEEK_API_KEY: sk-你的密钥
EOF
chmod 600 ~/.dsh/.credentials.yaml
```

**第 3 步：安装 fx-tui（npm）：**

```sh
npm install -g dsh-tui-fx          # 装 CLI，提供 fx 命令
dsh plugin --profile fx add dsh-tui-fx  # 装 dsh 插件（自动登记到 fx profile 的 bundles）
fx --help                          # 应输出 fx-tui 的帮助与版本号
```

想锁定版本可写成 `dsh-tui-fx@0.36.5`。安装日志里若出现
`missing peer @deepseek-ai/*`，属预期——`@deepseek-ai/cordis` / `dsh-agent` /
`dsh-llm` 由 dsh 本体提供，版本对齐由 dsh 在加载插件时校验。

<details>
<summary>从源码安装（开发 / 贡献者 / npm 不可用时）</summary>

```sh
git clone https://github.com/xianglifei/dsh-tui-fx.git && cd dsh-tui-fx
pnpm install && pnpm run build
dsh plugin --profile fx add "$(pwd)"
cp bin/fx /opt/homebrew/bin/fx   # 或任意 PATH 目录（Linux 常用 /usr/local/bin）
```

改动源码后 `pnpm run build` 即可生效（profile 软链到这份 checkout）；
`/update` 只会快进 git 克隆的安装，不适用于 npm 安装。

</details>

> `fx` 启动脚本自带防呆检测：dsh 未安装或 fx profile 未装时会给出对应的
> 修复命令，而不是裸报错。
