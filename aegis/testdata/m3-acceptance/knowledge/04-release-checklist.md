# Aegis 发布检查单（M3 测试资料）

## 提交前必须运行

```bash
pnpm verify
```

它依次运行：

1. `boundaries`
2. `comments`
3. `devlog:check`
4. `typecheck`
5. `build`
6. `resolve`
7. `lint`
8. `test`

顺序有意义：`build` 必须在 `resolve` 之前，因为解析门禁检查的是构建产物。

## 打包验证

```bash
pnpm package:verify
```

它会：

- 组装 `dist/Aegis.app`
- 复制随附 Node
- 启动打包产物
- 截图并检查 daemon 是否拉起

## 签名状态

当前正式 Developer ID 签名与公证尚未完成。

打包使用 ad-hoc 签名，仅适合本机验证；Gatekeeper 可能阻止其他机器直接打开。

## 代码约束

- 已发布的迁移文件只能新增，不能修改
- 业务代码不能直接用 `Date.now()` / `new Date()`
- 外发必须经过脱敏网关
- 不允许空 catch 静默失败
- 每个导出符号要有中文 JSDoc

## 发布前人工确认

- [ ] `pnpm verify` 全绿
- [ ] `pnpm package:verify` 通过
- [ ] 真实启动界面
- [ ] 数据目录/权限正确
- [ ] 没有把 Key、密码、Token 写进配置或日志
