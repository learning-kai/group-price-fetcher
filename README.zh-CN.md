# 分组倍率控制台

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-0969da)](https://github.com/learning-kai/group-price-fetcher)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-345f9d)](#快速开始)
[![GitHub release](https://img.shields.io/github/v/release/learning-kai/group-price-fetcher?include_prereleases&label=release)](https://github.com/learning-kai/group-price-fetcher/releases)

[English](README.md) | [简体中文](README.zh-CN.md)

把分散在各中转站后台的分组价格收成一个本地控制台：采集认证后的真实倍率、分别比较 GPT/Grok 定价域、加密保存凭据，并为其他本地工具提供稳定只读 API。

```bash
npm install
npm start
# 打开 http://127.0.0.1:5177
```

![分组倍率控制台](docs/assets/dashboard.png)

## 为什么做

中转站价格通常藏在登录后台里，接口格式不统一，还夹杂账号专属倍率。如果每次都要打开多个管理页、手抄 Token、再把秘密写进笔记或仓库，对比成本会高到没法日常运维。

这个项目就是为了把“采集、排序、历史、认证状态、通知、备份、对外只读接口”收进一个本机服务，同时避免把凭据明文落在项目目录。

## 核心特性

- 采集 **sub2api** 与 **NewAPI** 风格网关的分组倍率
- 将 **GPT / Grok** 作为独立定价域，跟踪认证后的当前账号倍率
- 支持密码、可移植 Token、公开采集、Token 增强，以及 Windows Edge Profile 兜底
- 凭据加密：Windows 用 **DPAPI**，Linux 用 **AES-256-GCM Vault**；SQLite 只存元数据
- 按站点、分类、标签、平台、分组状态、认证状态筛选排序
- 支持每站点换算系数和本地隐藏分组，不重写历史
- 显式记录新增/删除、倍率、说明、RPM、额度、计费、峰值规则变化
- 定时采集，带并发上限和单站失败隔离
- 可选通知：倍率变化、低余额、认证失败、采集失败
- 通过 `/api/external/v1` 提供稳定只读接口
- 支持 JSON/CSV 导出、密码加密的 `.gpfbackup` 灾备包，以及可移植 `.gpftransfer` 站点包

## 截图与演示

| 界面 | 默认地址 |
|---|---|
| 本地控制台 | `http://127.0.0.1:5177` |

控制台是本机服务。如果要公网访问，请让 Node 继续监听回环地址，并在反向代理上终止 HTTPS 与鉴权。

## 快速开始

### 环境要求

- Windows 10/11，或当前仍受支持的 Linux 发行版
- Node.js **22.5+**
- 仅在使用 Windows Edge Profile 提取时需要 Microsoft Edge

### Windows

```powershell
npm install
npm start
```

打开 [http://127.0.0.1:5177](http://127.0.0.1:5177)，添加站点，选择 Provider 与认证方式，然后执行第一次手动刷新。

可选：为当前 Windows 用户安装开机任务：

```powershell
npm run startup:install
# 卸载：
npm run startup:uninstall
```

### Linux

把数据目录和 Vault 密钥放在仓库外：

```bash
export GROUP_PRICE_FETCHER_HOME=/var/lib/group-price-fetcher
export GROUP_PRICE_FETCHER_VAULT_KEY="$(openssl rand -hex 32)"
npm install
npm start
```

重启后必须使用同一把 Vault 密钥；丢失或轮换后，旧凭据 vault 将无法解密。

Linux 支持公开采集、NewAPI Token、sub2api 密码和可移植 sub2api Token。Edge Profile 提取仍是 Windows 专属能力。

### 可移植 sub2api Token 流程

1. 在 Windows 上用站点专用 Edge Profile 登录
2. 编辑站点 → **提取 Edge 会话**
3. 将 Access Token / 可选 Refresh Token 保存进加密 vault，模式为 `sub2api-token`
4. 在 Linux 上直接粘贴相同字段，或导入 Windows 导出的加密 `.gpftransfer`

采集器会复用有效 Access Token，并在可刷新时自动轮换；刷新失败时站点进入 `login_required`。普通状态/导出接口不会返回原始 Token。

## 外部 API

本机回环请求默认不需要 API Key：

```bash
curl -sS http://127.0.0.1:5177/api/external/v1/sites
curl -sS http://127.0.0.1:5177/api/external/v1/rates
curl -sS http://127.0.0.1:5177/api/external/v1/changes
```

版本化资源：

```text
GET /api/external/v1/sites
GET /api/external/v1/rates
GET /api/external/v1/changes
GET /api/external/v1/sites/:id/rates
GET /api/external/v1/sites/:id/changes
GET /api/external/v1/sites/:id/groups/:groupId/history
```

局域网访问时，在设置中生成 API Key，以 `HOST=0.0.0.0` 启动，并发送：

```text
Authorization: Bearer <api-key>
```

管理端与凭据相关接口仍限制在本机回环。

## 导出、备份与迁移

| 路径 | 内容 | 适用场景 |
|---|---|---|
| JSON / CSV 导出 | 公开站点数据、当前倍率、变更记录 | 分享倍率，不含秘密 |
| `.gpfbackup` | SQLite 检查点 + 加密凭据 | 完整灾备恢复 |
| `.gpftransfer` | 可移植站点配置与账号凭据 | 实例间迁移站点 |

`.gpfbackup` 使用 scrypt（`N=32768`，`r=8`，`p=1`）与 AES-256-GCM。不包含 Edge Profile 和浏览器 Cookie。备份密码至少 10 位，且不会被保存。

离线恢复：

```powershell
npm run backup:restore -- "C:\path\to\backup.gpfbackup"
```

恢复前必须停止占用 5177 端口的服务。CLI 会在替换前创建恢复前备份；若替换失败，数据库与 vault 会成对回滚。

## 工程质量

```bash
npm test
npm run test:acceptance
```

测试使用 Node 内置 test runner 和临时 SQLite。覆盖多站并发、部分失败、认证刷新、Provider 归一化、变更历史、API 鉴权、凭据脱敏、跨平台迁移、Linux vault 加密、重启恢复，以及通知中心 UI/API 路径。最近完整运行结果为 **162** 项通过。

## 项目文档

| 路径 | 用途 |
|---|---|
| `docs/assets/` | 控制台截图 |
| `docs/site-transfer-format.md` | 可移植迁移包格式 |
| `docs/superpowers/` | 设计说明与实现计划 |
| `src/providers/` | sub2api / NewAPI 采集器 |
| `src/notificationService.js` | 通知渠道与派发 |
| `public/` | 控制台前端 |

## 隐私与安全边界

- 凭据静态加密；仓库中不应出现 vault key、`.env` 或线上数据库
- SQLite 保存运行元数据和倍率历史，不保存明文密码
- 外部 API 对站点/倍率/变更只读
- 管理与凭据接口默认仅本机可访问
- 公网部署必须在反向代理上做 HTTPS 与鉴权，不要把 Node 直接裸奔到 `0.0.0.0`
- 含凭据的备份受密码保护；密码丢失不可找回

## 发布与更新

- 当前版本：**0.1.0**
- 源码仓库：[learning-kai/group-price-fetcher](https://github.com/learning-kai/group-price-fetcher)
- 升级方式：拉取最新 `main`，执行 `npm install`，重启服务，并保持同一 `GROUP_PRICE_FETCHER_HOME` 与 vault key

```bash
git pull
npm install
npm test
npm start
```

## 路线图

- 更丰富的通知模板与投递日志
- 更清晰的多模型族定价视图
- 更完整的反向代理部署示例
- 可选的签名发布与打包流程

## 贡献

1. Fork 后创建功能分支
2. 不要提交凭据和本地 `data/`
3. 提 PR 前运行 `npm test`
4. 优先提交可审查的小改动，并附真实命令与测试夹具

反馈 issue 时，请尽量说明 Provider 类型、认证模式、Node 版本，以及已脱敏的复现路径。

## 许可证

[MIT](LICENSE) © 2026 learning-kai
