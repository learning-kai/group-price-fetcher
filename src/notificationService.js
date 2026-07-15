import { createHmac } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";

const NETWORK_TIMEOUT_MS = 10_000;
const CHANNEL_TYPES = new Set(["webhook", "telegram", "email", "wecom", "dingtalk", "feishu"]);
const CONFIG_FIELDS = {
  webhook: new Set(["url", "method", "headers"]),
  telegram: new Set(["botToken", "chatId"]),
  email: new Set(["host", "port", "secure", "useTls", "username", "password", "from", "recipients"]),
  wecom: new Set(["webhookUrl"]),
  dingtalk: new Set(["webhookUrl", "secret"]),
  feishu: new Set(["webhookUrl", "secret"])
};

export function createNotificationService({
  repository,
  credentialStore,
  fetchImpl = globalThis.fetch,
  smtpSend = sendSmtpMail,
  clock = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  queueCapacity = 100,
  onError = () => {}
}) {
  const capacity = Number.isInteger(queueCapacity) && queueCapacity > 0 ? queueCapacity : 100;
  const configCache = new Map();
  const queued = [];
  let outstanding = 0;
  let processing = null;
  let closing = false;
  async function createChannel(input) {
    validateType(input.type);
    const config = normalizeConfig(input.type, input.config);
    const channel = repository.createNotificationChannel(input);
    try {
      await credentialStore.set(reference(channel.id), { config: JSON.stringify(config) });
      configCache.set(channel.id, config);
    } catch (error) {
      repository.deleteNotificationChannel(channel.id);
      throw error;
    }
    return publicChannel(channel, true, config);
  }

  async function listChannels() {
    return Promise.all(repository.listNotificationChannels().map(async (channel) => {
      const config = await readStoredConfig(channel.id);
      return publicChannel(channel, Boolean(config), config);
    }));
  }

  async function updateChannel(id, patch) {
    const current = requireChannel(id);
    const type = patch.type ?? current.type;
    validateType(type);
    let config;
    if (hasConfigValues(patch.config)) {
      config = normalizeConfig(type, patch.config);
      await credentialStore.set(reference(id), { config: JSON.stringify(config) });
      configCache.set(id, config);
    } else {
      config = await readStoredConfig(id);
      if (patch.type !== undefined && patch.type !== current.type) {
        config = normalizeConfig(type, config);
        await credentialStore.set(reference(id), { config: JSON.stringify(config) });
        configCache.set(id, config);
      }
    }
    const channel = repository.updateNotificationChannel(id, patch);
    return publicChannel(channel, Boolean(config), config);
  }

  async function deleteChannel(id) {
    const channel = repository.getNotificationChannel(id);
    if (!channel) return false;
    await credentialStore.delete(reference(id));
    configCache.delete(id);
    return repository.deleteNotificationChannel(id);
  }

  async function testChannel(id) {
    const channel = requireChannel(id);
    return sendAndRecord(channel, {
      eventType: "test",
      message: "通知渠道测试",
      payload: { test: true, sentAt: toIso(clock()) }
    });
  }

  async function dispatchCollectionChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return { sent: 0 };
    const policy = repository.getNotificationPolicy();
    let sent = 0;
    for (const channel of repository.listNotificationChannels().filter((item) => item.enabled)) {
      const eligible = changes.filter((change) => matchesChannel(channel, change, policy));
      const ready = eligible.filter((change) => !isCoolingDown(channel.id, change, policy));
      if (ready.length === 0) continue;
      const subject = ready.length === 1
        ? eventLabel(ready[0].changeType)
        : `倍率站通知 · ${ready.length} 条事件`;
      const message = formatNotificationChanges(ready);
      await sendAndRecord(channel, {
        eventType: ready.length === 1 ? ready[0].changeType : "batch",
        subject,
        message,
        payload: { subject, message, changes: ready, sentAt: toIso(clock()) }
      });
      for (const change of ready.filter(hasCooldown)) {
        repository.setNotificationCooldown(channel.id, cooldownKey(change), clock());
      }
      sent += 1;
    }
    return { sent };
  }

  async function sendAndRecord(channel, notification) {
    let attempts = 0;
    const maxAttempts = repository.getNotificationPolicy().retryAttempts;
    try {
      const config = await readConfig(channel);
      while (attempts < maxAttempts) {
        attempts += 1;
        try {
          await sendDestination(channel.type, config, notification);
          const log = repository.createNotificationLog({
            channelId: channel.id,
            eventType: notification.eventType,
            status: "sent",
            message: notification.message,
            attempts
          });
          return { status: log.status, attempts: log.attempts };
        } catch (error) {
          const safeError = toSafeSendError(error);
          if (!isTransient(safeError) || attempts >= maxAttempts) throw safeError;
          await sleep(100 * (2 ** (attempts - 1)));
        }
      }
    } catch (error) {
      const safeError = toSafeSendError(error);
      repository.createNotificationLog({
        channelId: channel.id,
        eventType: notification.eventType,
        status: "failed",
        message: notification.message,
        errorCode: safeError.code,
        errorMessage: safeErrorMessage(safeError),
        attempts: Math.max(1, attempts)
      });
      throw safeError;
    }
  }

  async function sendDestination(type, config, notification) {
    const text = notification.message;
    if (type === "webhook") {
      await request(config.url, {
        method: config.method,
        headers: { "Content-Type": "application/json", ...config.headers },
        body: JSON.stringify(notification.payload)
      });
      return;
    }
    if (type === "telegram") {
      await requestJson(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text })
      }, (body) => body?.ok === true);
      return;
    }
    if (type === "wecom") {
      await requestJson(config.webhookUrl, jsonPost({ msgtype: "text", text: { content: text } }), (body) => body?.errcode === 0);
      return;
    }
    if (type === "dingtalk") {
      const url = new URL(config.webhookUrl);
      if (config.secret) {
        const timestamp = String(new Date(clock()).getTime());
        const sign = createHmac("sha256", config.secret).update(`${timestamp}\n${config.secret}`).digest("base64");
        url.searchParams.set("timestamp", timestamp);
        url.searchParams.set("sign", sign);
      }
      await requestJson(url, jsonPost({ msgtype: "text", text: { content: text } }), (body) => body?.errcode === 0);
      return;
    }
    if (type === "feishu") {
      const body = { msg_type: "text", content: { text } };
      if (config.secret) {
        const timestamp = String(Math.floor(new Date(clock()).getTime() / 1000));
        body.timestamp = timestamp;
        body.sign = createHmac("sha256", `${timestamp}\n${config.secret}`).update("").digest("base64");
      }
      await requestJson(config.webhookUrl, jsonPost(body), (value) => value?.code === 0 || value?.StatusCode === 0);
      return;
    }
    await smtpSend(config, {
      from: config.from,
      to: [...config.recipients],
      subject: notification.subject ?? notification.message,
      text
    });
  }

  async function requestJson(url, options, isSuccess) {
    const response = await request(url, options);
    let body;
    try {
      body = await response.json();
    } catch {
      throw safeSendError("通知服务响应无效", "NOTIFICATION_INVALID_RESPONSE", 502);
    }
    if (!isSuccess(body)) throw safeSendError("通知服务拒绝请求", "NOTIFICATION_REJECTED", 400);
  }

  async function request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 0;
        throw safeSendError("通知请求失败", "NOTIFICATION_HTTP_ERROR", status);
      }
      return response;
    } catch (error) {
      if (error?.safeToExpose) throw error;
      throw safeSendError("通知网络请求失败", "NOTIFICATION_NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }

  async function readStoredConfig(id) {
    if (configCache.has(id)) return configCache.get(id);
    const stored = await credentialStore.get(reference(id));
    if (!stored?.config) return null;
    try {
      const value = JSON.parse(stored.config);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      configCache.set(id, value);
      return value;
    } catch {
      return null;
    }
  }

  async function readConfig(channel) {
    const config = await readStoredConfig(channel.id);
    if (!config) throw safeSendError("通知渠道尚未配置", "NOTIFICATION_NOT_CONFIGURED", 400);
    return normalizeConfig(channel.type, config);
  }

  function isCoolingDown(channelId, change, policy) {
    if (!hasCooldown(change)) return false;
    const lastSentAt = repository.getNotificationCooldown(channelId, cooldownKey(change));
    const cooldownMs = change.changeType === "balance_low"
      ? Number(policy.balanceCooldownHours) * 3_600_000
      : Number(policy.failureCooldownMinutes) * 60_000;
    if (!lastSentAt || cooldownMs <= 0) return false;
    return new Date(clock()).getTime() - new Date(lastSentAt).getTime() < cooldownMs;
  }

  function enqueueCollectionChanges(changes) {
    return enqueue(changes);
  }

  function enqueueEvent(event) {
    return enqueue([event]);
  }

  function enqueue(changes) {
    if (closing || !Array.isArray(changes) || changes.length === 0 || outstanding >= capacity) return false;
    queued.push(changes);
    outstanding += 1;
    if (!processing) processing = processQueue();
    return true;
  }

  async function processQueue() {
    while (queued.length > 0) {
      const changes = queued.shift();
      try {
        await dispatchCollectionChanges(changes);
      } catch (error) {
        try { onError(error); } catch {}
      } finally {
        outstanding -= 1;
      }
    }
    processing = null;
  }

  return {
    createChannel,
    listChannels,
    updateChannel,
    deleteChannel,
    testChannel,
    dispatchCollectionChanges,
    enqueueCollectionChanges,
    enqueueEvent,
    listLogs: (options) => repository.listNotificationLogs(options),
    async close() {
      closing = true;
      await processing;
    }
  };

  function requireChannel(id) {
    const channel = repository.getNotificationChannel(id);
    if (!channel) throw Object.assign(new Error(`通知渠道不存在：${id}`), { status: 404 });
    return channel;
  }
}

function normalizeConfig(type, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("通知配置必须是对象");
  if (type === "webhook") return normalizeWebhook(input);
  if (type === "telegram") {
    return {
      botToken: requiredString(input.botToken, "Telegram Bot Token"),
      chatId: requiredString(input.chatId, "Telegram Chat ID")
    };
  }
  if (type === "wecom") return { webhookUrl: httpUrl(input.webhookUrl, "企业微信 Webhook URL") };
  if (type === "dingtalk" || type === "feishu") {
    const config = { webhookUrl: httpUrl(input.webhookUrl, "Webhook URL") };
    const secret = optionalString(input.secret, "签名密钥");
    if (secret) config.secret = secret;
    return config;
  }
  return normalizeEmail(input);
}

function normalizeWebhook(input) {
  const url = httpUrl(input.url, "Webhook URL");
  const method = String(input.method ?? "POST").toUpperCase();
  if (!new Set(["POST", "PUT"]).has(method)) throw new Error("Webhook 方法不支持");
  const headers = input.headers ?? {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Webhook Headers 必须是对象");
  for (const [name, value] of Object.entries(headers)) {
    if (hasCrlf(name) || typeof value !== "string" || hasCrlf(value)) throw new Error("Webhook Header 无效");
  }
  return { url, method, headers: { ...headers } };
}

function normalizeEmail(input) {
  const host = requiredString(input.host, "SMTP 主机");
  if (hasCrlf(host) || /\s/.test(host)) throw new Error("SMTP 主机无效");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SMTP 端口无效");
  const secure = booleanValue(input.secure, false, "SMTP secure");
  const useTls = booleanValue(input.useTls, false, "SMTP useTls");
  const username = optionalString(input.username, "SMTP 用户名");
  const password = optionalString(input.password, "SMTP 密码", false);
  if (Boolean(username) !== Boolean(password)) throw new Error("SMTP 用户名和密码必须同时配置");
  const from = emailAddress(input.from, "发件人");
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) throw new Error("收件人不能为空");
  const recipients = input.recipients.map((value) => emailAddress(value, "收件人"));
  const config = { host, port, secure, useTls, from, recipients };
  if (username) {
    config.username = username;
    config.password = password;
  }
  return config;
}

function validateType(type) {
  if (!CHANNEL_TYPES.has(type)) throw new Error("通知渠道类型不支持");
}

function publicChannel(channel, configured, config) {
  const allowed = CONFIG_FIELDS[channel.type] ?? new Set();
  const configFields = config
    ? Object.keys(config).filter((field) => allowed.has(field)).sort()
    : [];
  return { ...channel, configured: Boolean(configured), configFields };
}

function requiredString(value, label) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label} 不能为空`);
  const text = String(value).trim();
  if (!text || hasCrlf(text)) throw new Error(`${label} 无效`);
  return text;
}

function optionalString(value, label, trim = true) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} 无效`);
  const text = trim ? value.trim() : value;
  if (!text || hasCrlf(text)) throw new Error(`${label} 无效`);
  return text;
}

function booleanValue(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
}

function httpUrl(value, label) {
  const raw = requiredString(value, label);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} 无效`); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error(`${label} 无效`);
  return parsed.toString();
}

function emailAddress(value, label) {
  const address = requiredString(value, label);
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address)) throw new Error(`${label} 无效`);
  return address;
}

function hasCrlf(value) {
  return /[\r\n]/.test(String(value));
}

function hasConfigValues(config) {
  return config && typeof config === "object" && !Array.isArray(config) && Object.keys(config).length > 0;
}

function jsonPost(body) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function eventLabel(type) {
  return {
    ratio_changed: "倍率变化",
    group_added: "新增分组",
    group_removed: "删除分组",
    balance_low: "余额过低",
    auth_failed: "认证失败",
    collection_failed: "采集失败",
    test: "渠道测试"
  }[type] ?? "倍率站通知";
}

function formatNotificationChanges(changes) {
  return changes.map((change) => {
    const site = String(change.siteName ?? `站点 #${change.siteId ?? "?"}`);
    const group = String(change.groupName ?? change.groupId ?? "未知分组");
    if (change.changeType === "ratio_changed") {
      const percent = Number(change.changePercent);
      const percentText = Number.isFinite(percent) ? `（${percent > 0 ? "+" : ""}${percent.toFixed(2)}%）` : "";
      return `【倍率变化】${site} · ${group}：${formatEventValue(change.oldValue)} → ${formatEventValue(change.newValue)}${percentText}`;
    }
    if (change.changeType === "group_added") return `【新增分组】${site} · ${group}`;
    if (change.changeType === "group_removed") return `【删除分组】${site} · ${group}`;
    if (change.changeType === "balance_low") {
      return `【低余额】${site}：${formatUsd(change.balanceUsd)}，阈值 ${formatUsd(change.balanceThresholdUsd)}`;
    }
    if (change.changeType === "auth_failed") return `【认证失败】${site}：请重新检查登录态或访问凭据`;
    if (change.changeType === "collection_failed") return `【采集失败】${site}：上游倍率或余额采集失败`;
    return `【${eventLabel(change.changeType)}】${site}${change.message ? `：${String(change.message)}` : ""}`;
  }).join("\n");
}

function formatEventValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object") {
    const candidate = value.effectiveRateMultiplier ?? value.effective_rate_multiplier ?? value.rate ?? value.ratio;
    if (Number.isFinite(Number(candidate))) return String(Number(candidate));
    return "已更新";
  }
  return String(value);
}

function formatUsd(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : "$—";
}

function matchesChannel(channel, change, policy) {
  if (channel.subscriptions.length > 0 && !channel.subscriptions.includes(Number(change.siteId))) return false;
  if (channel.eventTypes.length > 0 && !channel.eventTypes.includes(change.changeType)) return false;
  if (change.changeType === "ratio_changed") {
    const percent = Number(change.changePercent);
    if (!Number.isFinite(percent) || Math.abs(percent) < Number(policy.minRatioChangePercent ?? 0)) return false;
  }
  return true;
}

function cooldownKey(change) {
  return `site:${change.siteId}:${change.changeType}`;
}

function hasCooldown(change) {
  return change.changeType === "balance_low"
    || change.changeType === "auth_failed"
    || change.changeType === "collection_failed";
}

function reference(id) {
  return `notification:${id}`;
}

function isTransient(error) {
  return !Number.isInteger(error?.status) || error.status === 408 || error.status === 429 || error.status >= 500;
}

function safeSendError(message, code, status) {
  const error = Object.assign(new Error(message), { code, safeToExpose: true });
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function toSafeSendError(error) {
  if (error?.safeToExpose) return error;
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  return safeSendError("通知发送失败", "NOTIFICATION_SEND_FAILED", status);
}

function safeErrorMessage(error) {
  return Number.isInteger(error?.status) ? `通知发送失败：HTTP ${error.status}` : "通知发送失败";
}

function toIso(value) {
  return new Date(value).toISOString();
}

export async function sendSmtpMail(config, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  timer.unref?.();
  let socket;
  try {
    socket = config.secure
      ? tls.connect(tlsOptions(config))
      : net.createConnection({ host: config.host, port: config.port });
    controller.signal.addEventListener("abort", () => socket.destroy(new Error("SMTP timeout")), { once: true });
    let reader = createSmtpReader(socket);
    await once(socket, config.secure ? "secureConnect" : "connect", { signal: controller.signal });
    await reader.read(220);
    await smtpCommand(socket, reader, "EHLO localhost", 250, controller.signal);

    if (!config.secure && config.useTls) {
      await smtpCommand(socket, reader, "STARTTLS", 220, controller.signal);
      reader.close();
      socket = tls.connect({ ...tlsOptions(config), socket });
      controller.signal.addEventListener("abort", () => socket.destroy(new Error("SMTP timeout")), { once: true });
      reader = createSmtpReader(socket);
      await once(socket, "secureConnect", { signal: controller.signal });
      await smtpCommand(socket, reader, "EHLO localhost", 250, controller.signal);
    }

    if (config.username && config.password) {
      await smtpCommand(socket, reader, "AUTH LOGIN", 334, controller.signal);
      await smtpCommand(socket, reader, Buffer.from(config.username).toString("base64"), 334, controller.signal);
      await smtpCommand(socket, reader, Buffer.from(config.password).toString("base64"), 235, controller.signal);
    }
    await smtpCommand(socket, reader, `MAIL FROM:<${config.from}>`, 250, controller.signal);
    for (const recipient of config.recipients) {
      await smtpCommand(socket, reader, `RCPT TO:<${recipient}>`, 250, controller.signal);
    }
    await smtpCommand(socket, reader, "DATA", 354, controller.signal);
    await smtpCommand(socket, reader, formatSmtpMessage(message), 250, controller.signal, true);
    socket.write("QUIT\r\n");
    reader.close();
  } finally {
    clearTimeout(timer);
    socket?.end();
  }
}

function tlsOptions(config) {
  const options = { host: config.host, port: config.port };
  if (!net.isIP(config.host)) options.servername = config.host;
  return options;
}

function createSmtpReader(socket) {
  let buffer = "";
  let current = [];
  const queued = [];
  const waiting = [];
  let failure;

  const settle = (value) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(value);
    else queued.push(value);
  };
  const fail = (error) => {
    failure = error;
    while (waiting.length) waiting.shift().reject(error);
  };
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      current.push(line);
      if (/^\d{3} /.test(line)) {
        settle(current.join("\n"));
        current = [];
      }
    }
  };
  socket.on("data", onData);
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("SMTP connection closed")));

  return {
    async read(expectedCode) {
      const response = queued.length
        ? queued.shift()
        : await new Promise((resolve, reject) => {
          if (failure) reject(failure);
          else waiting.push({ resolve, reject });
        });
      if (!response.startsWith(String(expectedCode))) throw new Error("SMTP command rejected");
      return response;
    },
    close() {
      socket.off("data", onData);
      socket.off("error", fail);
    }
  };
}

async function smtpCommand(socket, reader, command, expectedCode, signal, raw = false) {
  const output = raw ? `${command}\r\n.\r\n` : `${command}\r\n`;
  if (!socket.write(output)) await once(socket, "drain", { signal });
  return reader.read(expectedCode);
}

function formatSmtpMessage(message) {
  const text = String(message.text ?? "").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  const subject = Buffer.from(String(message.subject ?? ""), "utf8").toString("base64");
  return [
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text
  ].join("\r\n");
}
