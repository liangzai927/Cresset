# Aegis 运维手册（M3 测试资料）

## 数据目录

默认：

```text
~/Library/Application Support/Aegis
```

测试时可用：

```bash
export AEGIS_DATA_DIR="$HOME/Library/Application Support/Aegis-M3-Test"
```

## daemon 与 UDS

daemon 通过 Unix Domain Socket 与界面通信：

```text
~/Library/Application Support/Aegis/daemon.sock
```

同一数据目录只能运行一个 daemon。

## 旧 checkout 占着 UDS 怎么办

典型症状：

- 新 daemon 启动后立刻退出
- 界面连到旧代码
- 日志显示 socket 已存在

排查：

```bash
lsof -U | grep "Application Support/Aegis/daemon.sock"
```

处理：

1. 找到占用进程
2. 正常停止旧 daemon
3. 再启动新 checkout

不要直接删除 socket 文件；先确认进程是否还活着。

## channel.json

`channel.json` 是 Electron 与 daemon 之间的本地通道文件。

要求：

- 权限必须是 `0600`
- daemon 必须校验其中的 `pid` 是否存活
- endpoint 必须是回环地址

## 启动与停止

开发态：

```bash
cd /Users/liuwenliang/lwl/Cresset/aegis
pnpm dev
```

打包产物：

```bash
open dist/Aegis.app
```

退出应用不等于退出 daemon；daemon 设计为常驻。

## 备份

备份包含：

- SQLite 数据库快照
- config.json
- 附件

不包含：

- 系统钥匙串里的凭据

备份文件不应提交到 Git。

## 日志

桌面日志：

```text
~/Library/Application Support/Aegis/desktop.log
```

daemon 日志通过桌面日志转发；重点看：

- `scheduler.*`
- `monitor.*`
- `email_monitor.*`
- `shutdown.*`
- `main.ipc_error`
