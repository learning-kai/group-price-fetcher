# 分组倍率控制台

![许可证](https://img.shields.io/badge/license-MIT-2ea44f)
![版本](https://img.shields.io/badge/version-0.1.0-0969da)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)
![平台](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)

[English](README.md) | [简体中文](README.zh-CN.md)

一个运行在 Windows 本地的分组倍率控制台，用于采集、比较并通过 API 提供 sub2api、NewAPI 及兼容网关的价格数据。

## 为什么做

中转站价格通常散落在需要登录的后台里，接口格式还各不相同。本项目把采集、排序、历史、认证状态和外部软件集成收进一个本地工具，并避免把凭据放进项目目录。

## 核心特性

- 采集 sub2api 风格接口和 NewAPI 的分组倍率。
- 支持 sub2api 邮箱密码、NewAPI 公开/Token 增强采集，以及持久化 Edge Profile 兜底。
- 使用 Windows DPAPI 加密保存账号凭据，SQLite 只保存元数据。
- 按站点、分类、标签、平台、分组状态和认证状态筛选排序。
- 显式记录分组新增删除、倍率、说明、RPM、额度、计费和峰值规则变化。
- 分层定时采集、并发上限控制和单站失败隔离。
- 通过 `/api/external/v1` 为本机或局域网其他软件提供稳定只读接口。

## 截图与演示

![分组倍率控制台](docs/assets/dashboard.png)

控制台默认运行在 `http://127.0.0.1:5177`。

## 快速开始

### 环境要求

- Windows 10 或 11
- Node.js 22.5 或更高版本
- 使用浏览器 Profile 认证时需要 Microsoft Edge

```powershell
npm install
npm start
```

打开 [http://127.0.0.1:5177](http://127.0.0.1:5177)，添加站点并选择 Provider 和认证方式，然后执行第一次手动刷新。

注册当前 Windows 用户登录后的自动任务：

```powershell
npm run startup:install
```

使用 `npm run startup:uninstall` 删除自动任务。

## 外部 API

本机回环请求不要求 API Key：

```powershell
Invoke-RestMethod http://127.0.0.1:5177/api/external/v1/sites
Invoke-RestMethod http://127.0.0.1:5177/api/external/v1/rates
Invoke-RestMethod http://127.0.0.1:5177/api/external/v1/changes
```

稳定的版本化资源：

```text
GET /api/external/v1/sites
GET /api/external/v1/rates
GET /api/external/v1/changes
GET /api/external/v1/sites/:id/rates
GET /api/external/v1/sites/:id/changes
GET /api/external/v1/sites/:id/groups/:groupId/history
```

局域网访问需要在设置中生成 API Key，以 `HOST=0.0.0.0` 启动，并发送 `Authorization: Bearer <API_KEY>`。管理和凭据接口仍只允许本机访问。

## 工程质量

项目使用 Node.js 内置测试框架和真实临时 SQLite 数据库。验收测试覆盖 60 站并发、部分失败、认证刷新、Provider 归一化、仅变化历史、API 鉴权、凭据脱敏和重启恢复。

```powershell
npm test
npm run test:acceptance
```

测试明确不包含截图、响应式、布局和视觉回归检查。

## 故障排查

- **5177 端口被占用：**停止旧 Node 进程，或通过其他 `PORT` 值启动。
- **Edge 登录窗口没有打开：**确认 Microsoft Edge 安装在 Windows 标准位置。
- **站点显示 `login_required`：**重新填写凭据或手动执行登录/验证；定时任务不会主动弹出登录窗口。
- **局域网 API 返回 401：**在设置中生成新 API Key，并作为 Bearer Token 发送。
- **换电脑后凭据无法使用：**DPAPI 与原 Windows 用户绑定，需要在新电脑重新填写凭据。

## 项目文档

- [认证、NewAPI、变化和外部 API 计划](docs/superpowers/plans/2026-07-13-auth-newapi-changes-external-api.md)
- [加密导出设计](docs/superpowers/specs/2026-07-13-provider-cleanup-encrypted-export-design.md)
- [加密导出实施计划](docs/superpowers/plans/2026-07-13-provider-cleanup-encrypted-export.md)

## 隐私与安全边界

运行数据位于项目目录之外：

```text
%LOCALAPPDATA%\GroupPriceFetcher\data\prices.db
%LOCALAPPDATA%\GroupPriceFetcher\data\credentials.vault
%LOCALAPPDATA%\GroupPriceFetcher\profiles
```

- 密码和 NewAPI Token 使用 Windows DPAPI CurrentUser 范围加密。
- Access Token、Refresh Token、Cookie 和密码不会写入 SQLite、日志、导出或 API 响应。
- API Key 只保存 SHA-256 哈希。
- DPAPI 和 Edge Profile 无法直接迁移到其他 Windows 用户；迁移后需要重新认证。
- 使用时应遵守各上游站点的服务条款、频率限制和访问规则。

## 发布与更新

当前源码版本为 `0.1.0`。开始使用标签发布后，发布说明和迁移信息会通过 GitHub Releases 提供。

## 路线图

- 移除可见的旧 Uling19 Provider，并把已有配置迁移到 sub2api。
- 增加普通 JSON/CSV 导出。
- 增加密码加密的可迁移完整备份和离线恢复。
- 核心备份流程稳定后增加可选变化通知。

## 贡献

欢迎提交 Issue 和范围清晰的 Pull Request。不要把凭据或运行数据库放进测试夹具，新增功能应先写行为测试，并在提交前运行 `npm test`。

## 许可证

本项目采用 [MIT License](LICENSE) 发布。
