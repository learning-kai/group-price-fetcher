# GPF 站点交换格式 v1

`.gpftransfer` 用于在互不共享数据库的 Windows 与服务器实例之间交换站点配置和账号凭据。文件不包含倍率、历史、变化记录、API Key、隐藏分组或浏览器登录态。

## 加密信封

- 文本编码：UTF-8 JSON
- KDF：scrypt，`N=32768`、`r=8`、`p=1`，输出 32 字节密钥
- salt：16 个随机字节，Base64
- 加密：AES-256-GCM
- IV：12 个随机字节，Base64
- tag：16 字节，Base64
- AAD：UTF-8 字符串 `group-price-fetcher-backup:v1`
- 密码：至少 10 个字符，按 UTF-8 处理

信封字段：

```json
{
  "format": "group-price-fetcher-backup",
  "formatVersion": 1,
  "cipher": "aes-256-gcm",
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "Base64" },
  "iv": "Base64",
  "tag": "Base64",
  "ciphertext": "Base64"
}
```

解密明文是紧凑 UTF-8 JSON，结构如下：

```json
{
  "payloadType": "site-transfer",
  "payloadVersion": 1,
  "createdAt": "2026-07-13T00:00:00.000Z",
  "sites": [
    {
      "name": "示例站",
      "baseUrl": "https://example.com",
      "providerId": "sub2api",
      "categoryName": "生产",
      "tags": ["重点"],
      "scheduleMinutes": 30,
      "enabled": true,
      "rateConversionFactor": 0.1,
      "authMode": "sub2api-password",
      "credentials": { "email": "user@example.com", "password": "secret" }
    }
  ]
}
```

`sub2api-password` 的凭据字段固定为 `email`、`password`；`sub2api-token` 固定为 `accessToken`、`refreshToken`，其中 Access Token 必填、Refresh Token 可以是空字符串；`newapi-token` 固定为 `accessToken`、`userId`。`public` 和 `edge-profile` 的 `credentials` 必须是 `null`。

导入以规范化后的 `baseUrl` 判断同一站点：相同 URL 覆盖配置和凭据，不删除倍率历史。交换包中没有凭据时会清除目标端旧凭据。`edge-profile` 无法跨平台迁移，导入后会禁用站点并要求重新登录。

## 固定测试向量

- 密码：`transfer-vector-password`
- salt（十六进制）：`000102030405060708090a0b0c0d0e0f`
- IV（十六进制）：`101112131415161718191a1b`
- 完整信封：见自动化测试 `test/siteTransferService.test.js` 中的 `published cross-platform vector` 用例

任何独立服务器实现都应能解密该向量，并得到 `payloadType=site-transfer`、密码字段 `vector-secret` 和倍率换算系数 `0.1`。
