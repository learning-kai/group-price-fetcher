# Provider 清理与加密导出设计

## 目标

1. 从用户可见的 Provider 列表移除 `Uling19 / AI API Gateway`。
2. 将已有 `uling-gateway` 站点无损迁移为 `sub2api`，保留 URL、认证方式、历史、分类、标签和调度配置。
3. 提供普通数据导出和可迁移的加密完整备份。
4. 提供离线恢复命令，确保完整备份不是只能生成、不能恢复的死文件。

## 非目标

- 不导出或迁移 Edge Profile、浏览器 Cookie 和 localStorage。
- 不提供运行中数据库热替换。
- 不进行布局、截图、响应式或视觉回归测试。
- 不改变现有外部只读 API 契约。

## Provider 迁移

- Provider 注册表只公开 `sub2api` 和 `newapi`。
- 默认 Provider 从 `uling-gateway` 改为 `sub2api`。
- SQLite `user_version` 升级到 4。
- v4 迁移执行：

```sql
UPDATE sites
SET provider_id = 'sub2api'
WHERE provider_id = 'uling-gateway';
```

- `ulingGateway.js` 中仍被 sub2api 复用的归一化函数可以暂时作为内部实现保留，但不再注册为 Provider，也不会出现在界面选项中。
- 旧调用显式传入 `providerId=uling-gateway` 时返回未知 Provider，避免继续制造旧配置。

## 普通数据导出

管理面新增两个仅限本机访问的下载接口：

```text
GET /api/exports/data.json
GET /api/exports/rates.csv
```

JSON 内容：

```json
{
  "formatVersion": 1,
  "exportedAt": "ISO-8601",
  "sites": [],
  "rates": [],
  "changes": []
}
```

- `sites` 不包含脱敏用户名以外的认证资料。
- `rates` 导出全部当前有效倍率，不受界面当前分页影响。
- `changes` 导出全部变化事件，不受界面当前分页影响。
- CSV 只导出当前倍率，列名稳定，使用 UTF-8 BOM 兼容 Excel。
- 普通导出永远不包含密码、Token、Cookie、API Key 哈希或凭据引用。

## 加密完整备份

管理面新增本机接口：

```text
POST /api/exports/encrypted-backup
Content-Type: application/json

{"password":"用户输入的备份密码"}
```

密码要求至少 10 个字符。服务端完成导出后直接返回附件，不记录密码，不在响应 JSON、日志或 SQLite 中保存密码。

备份明文载荷在内存中组装，包含：

```json
{
  "payloadVersion": 1,
  "createdAt": "ISO-8601",
  "database": {
    "encoding": "base64",
    "sha256": "...",
    "content": "..."
  },
  "credentials": {
    "site:1": {"email":"...","password":"..."},
    "site:2": {"accessToken":"...","userId":"..."}
  }
}
```

导出数据库前执行 WAL checkpoint，确保备份文件包含最近提交的数据。凭据由 `credentialStore` 在内存中解密，随整个载荷一起加密，不单独写明文临时文件。

`.gpfbackup` 文件是 JSON 信封：

```json
{
  "format": "group-price-fetcher-backup",
  "formatVersion": 1,
  "cipher": "aes-256-gcm",
  "kdf": {
    "name": "scrypt",
    "N": 32768,
    "r": 8,
    "p": 1,
    "salt": "base64"
  },
  "iv": "base64",
  "tag": "base64",
  "ciphertext": "base64"
}
```

- KDF：`scrypt`，随机 16 字节 salt，`N=32768`、`r=8`、`p=1`。
- 加密：AES-256-GCM，随机 12 字节 IV，128 位认证标签。
- 错误密码、密文修改或截断都会导致认证失败，不返回部分明文。
- 加密数据和数据库读取允许驻留内存，但不写入工作区或 `%TEMP%` 明文文件。

## 离线恢复

新增命令：

```powershell
npm run backup:restore -- "C:\path\backup.gpfbackup"
```

命令通过隐藏输入提示读取备份密码，密码不出现在命令行参数和 shell 历史中。

恢复流程：

1. 检查正式服务端口未监听，拒绝运行中恢复。
2. 读取并解析备份信封。
3. 使用密码派生密钥并通过 AES-GCM 解密。
4. 校验载荷版本、数据库 SHA-256 和 SQLite 必需表。
5. 将当前 `prices.db` 和 `credentials.vault` 复制为带时间戳的恢复前备份。
6. 通过同目录临时文件写入数据库，再原子替换 `prices.db`。
7. 使用当前 Windows 用户的 DPAPI 重新写入 `credentials.vault`。
8. 打开恢复后的数据库执行现有幂等迁移，然后退出。

任一步骤失败时，不覆盖当前数据；如果数据库或 DPAPI 凭据库已经替换，则自动成对恢复步骤 5 的两个备份并返回错误。

## 界面

“采集设置”增加数据导出区：

- `导出 JSON`
- `导出 CSV`
- 备份密码输入框
- 确认密码输入框
- `导出加密备份`

浏览器通过 Blob 下载响应。密码字段提交完成后立即清空，页面不缓存或回显密码。

## 错误处理

- 密码过短或两次输入不一致：客户端阻止提交，服务端再次校验。
- WAL checkpoint、数据库读取或 DPAPI 解密失败：返回错误，不生成残缺下载。
- 数据库过大：当前实现允许内存导出；不额外引入流式容器格式，避免超出本次范围。
- 下载取消不会留下服务端明文文件。
- 恢复时检测到未知格式、校验失败或错误密码：拒绝替换现有数据。

## 测试

- v4 迁移将旧 Provider 改为 `sub2api`，且注册表不再列出 `uling-gateway`。
- JSON/CSV 导出不含认证资料，并导出全部数据而非单页。
- 加密备份可以正确解密，错误密码和篡改密文会失败。
- 加密文件中搜索不到测试密码、Token、邮箱和 SQLite 明文标记。
- 离线恢复能恢复数据库与凭据，并在失败时保留原数据库。
- HTTP 下载包含正确的 MIME、文件名和 `Content-Disposition`。
- 全量现有测试继续通过。
- 不执行任何布局或视觉测试。

## 安全边界

- 所有导出和恢复管理能力仅允许本机使用。
- 外部 `/api/external/v1` 仍然只读，不能触发完整备份。
- 普通导出不含凭据。
- 完整备份包含高敏感资料，安全性取决于用户设置的备份密码；文件丢失后应视密码强度评估风险。
- API Key 原文不导出；恢复后可在新环境重新生成。
