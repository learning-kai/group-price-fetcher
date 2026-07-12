# 最新倍率分组隐藏与恢复设计

## 目标

允许用户在“最新倍率”页面隐藏不需要关注的单个分组，并从同一页面的“已隐藏”视图恢复。隐藏偏好必须跨页面刷新和服务重启保留，但不得删除或改变倍率、历史、变化记录、普通导出或外部 API 数据。

## 已确认范围

- 隐藏键为 `(site_id, group_id)`，只影响当前站点的当前分组。
- 默认“最新倍率”视图只显示未隐藏分组。
- 筛选栏提供“正常显示 / 已隐藏”模式；“已隐藏”模式只显示当前仍存在的隐藏分组。
- 普通 JSON/CSV 导出、加密完整备份、外部 API、倍率历史和变化记录继续包含完整数据。
- 分组暂时从上游消失时保留隐藏偏好；同一站点、同一 `group_id` 日后重新出现时仍保持隐藏，用户可在“已隐藏”视图恢复。

## 数据模型

SQLite schema 升级到 v5，新增独立偏好表：

```sql
CREATE TABLE hidden_rate_groups (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (site_id, group_id)
);
```

隐藏状态不写入 `rate_versions`。这样采集产生新版本时不会丢失偏好，也不会污染历史数据。删除站点时由外键级联清理偏好。

仓库新增三个边界：

- `hideRateGroup(siteId, groupId)`：确认站点及当前分组存在后幂等写入。
- `restoreRateGroup(siteId, groupId)`：幂等删除隐藏偏好。
- `listLatestRates({ visibility })`：支持 `all | visible | hidden`。仓库默认 `all`，避免现有导出和外部 API 被意外过滤。

## API

本机管理 API 新增：

```text
PUT    /api/sites/:siteId/groups/:groupId/hidden
DELETE /api/sites/:siteId/groups/:groupId/hidden
GET    /api/rates?visibility=visible|hidden
```

- `PUT` 隐藏分组，成功返回当前隐藏状态。
- `DELETE` 恢复分组，重复调用仍成功。
- 管理端 `/api/rates` 默认 `visibility=visible`。
- 非法 `visibility` 返回 400；站点或当前分组不存在时隐藏操作返回 404。
- 路由继续使用现有 loopback 管理权限，局域网客户端不能修改隐藏偏好。
- `/api/external/v1/rates` 明确使用 `visibility=all`，不接受隐藏偏好过滤。

## 页面交互

“最新倍率”筛选栏新增 `rate-visibility` 模式选择：

- `正常显示`：每行保留“历史”，并增加“隐藏”。
- `已隐藏`：每行保留“历史”，并显示“恢复”。

隐藏或恢复成功后重置到第 1 页并重新加载倍率，避免当前页因移除最后一条记录而落入空页。操作期间禁用按钮，成功显示简短提示；失败沿用现有错误提示。隐藏是可逆操作，不弹二次确认。

当前分组数、分页总数和筛选结果以所选可见性模式为准。站点数、最低倍率和需登录数量继续按当前页现有逻辑计算。

## 数据边界

- `exportPublicData()` 保持现有直接查询，不连接 `hidden_rate_groups`。
- CSV 和 JSON 普通导出保持全部当前倍率。
- 加密备份包含完整 SQLite，因此自然包含隐藏偏好；离线恢复后偏好仍存在。
- 历史和变化查询不读取隐藏偏好。
- 采集保存逻辑不读取或修改隐藏偏好。

## 错误处理

- 仓库层严格校验正整数 `siteId` 和非空 `groupId`。
- 隐藏不存在的当前分组返回稳定 404，而不是创建无法在页面恢复的孤立偏好。
- 恢复操作幂等，偏好已不存在时仍返回可见状态。
- schema v5 迁移使用事务，失败时不提升 `user_version`。

## 测试与验收

- 存储测试：v5 迁移、隐藏/恢复幂等、站点删除级联、重新采集后隐藏仍保留、`all/visible/hidden` 查询结果。
- 服务测试：两个管理端点、默认只返回可见分组、隐藏列表、非法模式、非本机拒绝、外部 API 仍返回全部分组。
- UI 契约测试：模式控件、隐藏/恢复端点、两种行操作、成功后重载与翻页重置。
- 回归测试：普通导出仍包含隐藏分组，完整测试全部通过。
- 正式更新前备份数据库，重启后验证 schema v5、站点/倍率/变化数量不下降、现有页面可隐藏并恢复测试分组。

不增加布局、截图或视觉回归测试。
