# 站点倍率换算设计

## 目标

每个站点可配置一个正数换算系数，默认值为 `1`。当前倍率按以下公式统一换算：

```text
effectiveRateMultiplier = sourceEffectiveRateMultiplier * rateConversionFactor
```

例如充值 1 元获得 10 元站内余额时，站点系数填 `0.1`。

## 数据与行为

- SQLite schema 升级到 v6，`sites` 增加 `rate_conversion_factor REAL NOT NULL DEFAULT 1`。
- 创建和编辑站点接受 `rateConversionFactor`，必须是大于 0 的有限数。
- 原始采集值继续存入 `rate_versions.effective_rate_multiplier`，不重写历史，不产生虚假的变化事件。
- 倍率查询返回：
  - `sourceEffectiveRateMultiplier`：上游原始实际倍率。
  - `rateConversionFactor`：站点换算系数。
  - `effectiveRateMultiplier`：换算后的实际倍率。
- 最新倍率排序使用换算后的倍率。
- 最新倍率页面、历史页面、JSON/CSV 导出和外部 API 均显示换算后的 `effectiveRateMultiplier`，同时保留原始字段。
- CSV 新增 `source_effective_rate_multiplier` 和 `rate_conversion_factor` 列。
- 编辑站点弹窗新增“倍率换算系数”数字输入，默认 `1`，支持 `0.1`、`10` 等正数。

## 验证

- v6 迁移不改变现有站点、倍率和变化记录数量。
- 系数 `0.1` 将原始倍率 `0.8` 映射为 `0.08`，并按 `0.08` 排序。
- 修改系数立即影响查询，但数据库中的原始倍率和变化历史保持不变。
- JSON、CSV、外部 API 同时提供换算值、原始值和系数。
- 全量测试通过后备份正式数据库、重启 5177 并验证迁移。
