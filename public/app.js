const state = {
  view: "rates",
  categories: [],
  tags: [],
  providers: [],
  rates: { items: [], total: 0, page: 1, pageSize: 50 },
  changes: { items: [], total: 0, page: 1, pageSize: 100 },
  changeSiteId: null,
  sites: { items: [], total: 0, page: 1, pageSize: 200 },
  editingSite: null,
  loading: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

await init();

async function init() {
  bindEvents();
  try {
    await Promise.all([loadStatus(), loadReferenceData()]);
    await loadRates();
  } catch (error) {
    showError(error);
  }
}

function bindEvents() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", safeHandler(() => switchView(button.dataset.view))));
  $("#rate-filters").addEventListener("input", debounce(() => { state.rates.page = 1; loadRates(); }, 220));
  $("#rate-filters").addEventListener("change", () => { state.rates.page = 1; loadRates(); });
  $("#site-search").addEventListener("input", debounce(loadSites, 220));
  $("#site-auth-filter").addEventListener("change", loadSites);
  $("#change-type-filter").addEventListener("change", loadChanges);
  $("#clear-change-site").addEventListener("click", safeHandler(clearChangeSiteFilter));
  $("#page-prev").addEventListener("click", () => changeRatePage(-1));
  $("#page-next").addEventListener("click", () => changeRatePage(1));
  $("#open-site").addEventListener("click", () => openSiteDialog());
  $("#open-bulk").addEventListener("click", () => $("#bulk-dialog").showModal());
  $("#refresh-all").addEventListener("click", safeHandler(refreshAllSites));
  $("#site-form").addEventListener("submit", safeHandler(saveSite));
  $("#bulk-form").addEventListener("submit", safeHandler(bulkAddSites));
  $("#schedule-form").addEventListener("submit", safeHandler(saveGlobalSchedule));
  $("#category-form").addEventListener("submit", safeHandler(addCategory));
  $("#rotate-api-key").addEventListener("click", safeHandler(rotateApiKey));
  $("#export-json").addEventListener("click", safeHandler(exportJson));
  $("#export-csv").addEventListener("click", safeHandler(exportCsv));
  $("#backup-form").addEventListener("submit", safeHandler(exportEncryptedBackup));
  $("#site-provider").addEventListener("change", handleProviderChange);
  $("#site-auth-mode").addEventListener("change", updateCredentialFields);
  $("#sites-body").addEventListener("click", safeHandler(handleSiteAction));
  $("#rates-body").addEventListener("click", safeHandler(handleRateAction));
  $("#category-list").addEventListener("click", safeHandler(handleCategoryAction));
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
}

async function switchView(view) {
  state.view = view;
  $$("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  $$("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  const labels = {
    rates: ["RATE INDEX", "最新分组倍率"],
    changes: ["CHANGE LOG", "最近变化"],
    sites: ["SITE REGISTRY", "站点管理"],
    settings: ["SCHEDULER", "采集设置"]
  };
  $("#view-kicker").textContent = labels[view][0];
  $("#view-title").textContent = labels[view][1];
  if (view === "rates") await loadRates();
  if (view === "changes") await loadChanges();
  if (view === "sites") await loadSites();
  if (view === "settings") await loadSettings();
}

async function loadStatus() {
  const status = await api("/api/status");
  $("#scheduler-indicator").classList.toggle("online", status.scheduler.started);
  $("#scheduler-label").textContent = status.scheduler.started ? "调度器运行中" : "调度器待启动";
  $("#scheduler-detail").textContent = `${status.scheduler.runningSiteIds.length} 个站点采集中`;
  $("#global-schedule").value = status.globalScheduleMinutes;
}

async function loadReferenceData() {
  const [categories, tags, providers] = await Promise.all([api("/api/categories"), api("/api/tags"), api("/api/providers")]);
  state.categories = categories.items;
  state.tags = tags.items;
  state.providers = providers.providers;
  fillOptions("#category-filter", state.categories, "全部分类", (item) => [item.id, item.name]);
  fillOptions("#site-category", state.categories, "未分类", (item) => [item.id, item.name]);
  fillOptions("#tag-filter", state.tags, "全部标签", (item) => [item.name, `${item.name} (${item.siteCount})`]);
  $("#site-provider").innerHTML = state.providers.map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.label)}</option>`).join("");
  renderCategories();
}

async function loadChanges() {
  const params = new URLSearchParams({
    siteId: state.changeSiteId ?? "",
    changeType: $("#change-type-filter").value,
    page: 1,
    pageSize: state.changes.pageSize
  });
  try {
    state.changes = await api(`/api/changes?${params}`);
    renderChanges();
  } catch (error) {
    renderTableError("#changes-body", 7, error.message);
    showError(error);
  }
}

function renderChanges() {
  $("#changes-body").innerHTML = state.changes.items.length
    ? state.changes.items.map((change) => `
      <tr>
        <td class="time-cell">${formatDate(change.createdAt)}</td>
        <td><strong>${escapeHtml(change.siteName)}</strong></td>
        <td>${escapeHtml(change.groupName)}</td>
        <td>${escapeHtml(changeTypeLabel(change.changeType))}${change.changePercent === null ? "" : ` <span class="muted">${formatPercent(change.changePercent)}</span>`}</td>
        <td>${escapeHtml(formatChangeValue(change.oldValue))}</td>
        <td>${escapeHtml(formatChangeValue(change.newValue))}</td>
        <td>${badge(change.severity, change.severity === "critical" ? "danger" : change.severity === "warning" ? "accent" : "neutral")}</td>
      </tr>`).join("")
    : '<tr class="empty"><td colspan="7">暂无变化记录</td></tr>';
}

async function loadRates() {
  setLoading(true, "rates");
  const params = new URLSearchParams({
    query: $("#rate-search").value.trim(),
    categoryId: $("#category-filter").value,
    tag: $("#tag-filter").value,
    platform: $("#platform-filter").value,
    status: $("#group-status-filter").value,
    authStatus: $("#auth-filter").value,
    visibility: $("#rate-visibility").value,
    sortBy: $("#sort-field").value,
    sortDir: $("#sort-direction").value,
    page: state.rates.page,
    pageSize: state.rates.pageSize
  });
  try {
    state.rates = await api(`/api/rates?${params}`);
    renderRates();
  } catch (error) {
    renderTableError("#rates-body", 8, error.message);
    showError(error);
  } finally {
    setLoading(false, "rates");
  }
}

function renderRates() {
  const body = $("#rates-body");
  const items = state.rates.items;
  if (!items.length) {
    body.innerHTML = '<tr class="empty"><td colspan="8">没有符合条件的倍率记录</td></tr>';
  } else {
    body.innerHTML = items.map((rate) => `
      <tr>
        <td><div class="primary-cell"><strong>${escapeHtml(rate.siteName)}</strong><span>${escapeHtml(hostname(rate.baseUrl))}</span></div></td>
        <td>${rate.categoryName ? badge(rate.categoryName, "neutral") : '<span class="muted">未分类</span>'}</td>
        <td><div class="primary-cell"><strong>${escapeHtml(rate.groupName)}</strong><span>${escapeHtml(rate.platform || "未标记平台")}</span></div></td>
        <td>${statusBadge(rate.status || "active")}</td>
        <td class="numeric">${formatRate(rate.baseRateMultiplier)}</td>
        <td class="numeric rate-value">${formatRate(rate.effectiveRateMultiplier)}</td>
        <td class="time-cell">${formatDate(rate.validFrom)}</td>
        <td class="row-actions">
          <button type="button" data-action="history" data-site-id="${rate.siteId}" data-group-id="${escapeAttr(rate.groupId)}" data-label="${escapeAttr(`${rate.siteName} / ${rate.groupName}`)}">历史</button>
          ${rate.hidden
            ? `<button type="button" data-action="restore" data-site-id="${rate.siteId}" data-group-id="${escapeAttr(rate.groupId)}">恢复</button>`
            : `<button type="button" data-action="hide" data-site-id="${rate.siteId}" data-group-id="${escapeAttr(rate.groupId)}">隐藏</button>`}
        </td>
      </tr>`).join("");
  }
  const sites = new Set(items.map((item) => item.siteId));
  const loginRequired = items.filter((item) => item.authStatus === "login_required").length;
  $("#metric-groups").textContent = state.rates.total;
  $("#metric-sites").textContent = sites.size;
  $("#metric-min").textContent = items.length ? formatRate(Math.min(...items.map((item) => item.effectiveRateMultiplier))) : "—";
  $("#metric-auth").textContent = loginRequired;
  const pages = Math.max(1, Math.ceil(state.rates.total / state.rates.pageSize));
  $("#rate-page-label").textContent = `第 ${state.rates.page} / ${pages} 页 · ${state.rates.total} 条`;
  $("#page-prev").disabled = state.rates.page <= 1;
  $("#page-next").disabled = state.rates.page >= pages;
  mergePlatformOptions(items.map((item) => item.platform).filter(Boolean));
}

async function loadSites() {
  setLoading(true, "sites");
  const params = new URLSearchParams({
    query: $("#site-search").value.trim(),
    authStatus: $("#site-auth-filter").value,
    sortBy: "name",
    sortDir: "asc",
    page: 1,
    pageSize: 200
  });
  try {
    state.sites = await api(`/api/sites?${params}`);
    renderSites();
  } catch (error) {
    renderTableError("#sites-body", 7, error.message);
    showError(error);
  } finally {
    setLoading(false, "sites");
  }
}

function renderSites() {
  $("#sites-body").innerHTML = state.sites.items.length
    ? state.sites.items.map((site) => `
      <tr>
        <td><div class="primary-cell"><strong>${escapeHtml(site.name)}</strong><span title="${escapeAttr(site.baseUrl)}">${escapeHtml(site.baseUrl)}</span></div></td>
        <td><div class="tag-stack">${site.categoryName ? badge(site.categoryName, "neutral") : ""}${site.tags.map((tag) => badge(tag)).join("") || '<span class="muted">无标签</span>'}</div></td>
        <td>${authBadge(site.authStatus)}<span class="override-note">${escapeHtml(authModeLabel(site.authMode))}${site.authUsername ? ` · ${escapeHtml(site.authUsername)}` : ""}</span></td>
        <td><strong>${site.effectiveScheduleMinutes} 分钟</strong>${site.scheduleMinutes ? '<span class="override-note">站点覆盖</span>' : ""}</td>
        <td class="time-cell">${formatDate(site.nextRunAt)}</td>
        <td class="time-cell">${formatDate(site.lastCollectedAt)}</td>
        <td class="row-actions site-actions">
          <button type="button" data-action="refresh" data-id="${site.id}" title="立即刷新">↻</button>
          ${site.authMode === "edge-profile" ? `<button type="button" data-action="login" data-id="${site.id}">登录</button><button type="button" data-action="import-edge" data-id="${site.id}">导入</button>` : site.authMode !== "public" ? `<button type="button" data-action="login" data-id="${site.id}">验证</button>` : ""}
          <button type="button" data-action="changes" data-id="${site.id}">变化</button>
          <button type="button" data-action="edit" data-id="${site.id}">编辑</button>
          <button class="danger" type="button" data-action="delete" data-id="${site.id}" title="删除站点">×</button>
        </td>
      </tr>`).join("")
    : '<tr class="empty"><td colspan="7">还没有站点，先添加一个</td></tr>';
}

async function handleSiteAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  const site = state.sites.items.find((item) => item.id === id);
  if (!site) return;
  const action = button.dataset.action;
  if (action === "edit") return openSiteDialog(site);
  if (action === "changes") {
    state.changeSiteId = site.id;
    $("#change-site-label").textContent = `站点：${site.name}`;
    $("#change-site-label").hidden = false;
    $("#clear-change-site").hidden = false;
    return switchView("changes");
  }
  if (action === "delete") {
    if (!confirm(`删除站点“${site.name}”及其历史记录？`)) return;
    await withButton(button, () => api(`/api/sites/${id}`, { method: "DELETE" }));
    await Promise.all([loadSites(), loadRates(), loadReferenceData()]);
    return;
  }
  const endpoints = { refresh: "/refresh", login: "/login", "import-edge": "/import-edge" };
  await withButton(button, () => api(`/api/sites/${id}${endpoints[action]}`, { method: "POST" }));
  showToast(action === "refresh" ? "采集完成" : action === "login" ? "登录态已保存" : "Edge 登录态已导入");
  await Promise.all([loadSites(), loadRates()]);
}

async function handleRateAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (["hide", "restore"].includes(action)) {
    const methods = { hide: "PUT", restore: "DELETE" };
    const endpoint = `/api/sites/${button.dataset.siteId}/groups/${encodeURIComponent(button.dataset.groupId)}/hidden`;
    await withButton(button, () => api(endpoint, { method: methods[action] }));
    state.rates.page = 1;
    await loadRates();
    showToast(action === "hide" ? "分组已隐藏" : "分组已恢复");
    return;
  }
  if (action !== "history") return;
  $("#history-title").textContent = button.dataset.label;
  $("#history-body").innerHTML = '<tr class="empty"><td colspan="5">正在加载历史</td></tr>';
  $("#history-dialog").showModal();
  try {
    const data = await api(`/api/sites/${button.dataset.siteId}/history?groupId=${encodeURIComponent(button.dataset.groupId)}`);
    $("#history-body").innerHTML = data.items.length
      ? data.items.map((item) => `<tr><td>${formatDate(item.validFrom)}</td><td class="numeric">${formatRate(item.baseRateMultiplier)}</td><td class="numeric">${formatRate(item.userRateMultiplier)}</td><td class="numeric rate-value">${formatRate(item.effectiveRateMultiplier)}</td><td>${formatDate(item.validTo)}</td></tr>`).join("")
      : '<tr class="empty"><td colspan="5">暂无历史变化</td></tr>';
  } catch (error) {
    renderTableError("#history-body", 5, error.message);
  }
}

function openSiteDialog(site = null) {
  state.editingSite = site;
  $("#site-dialog-title").textContent = site ? "编辑站点" : "添加站点";
  $("#site-id").value = site?.id ?? "";
  $("#site-name").value = site?.name ?? "";
  $("#site-url").value = site?.baseUrl ?? "";
  $("#site-provider").value = site?.providerId ?? "uling-gateway";
  $("#site-auth-mode").value = site?.authMode ?? defaultAuthMode($("#site-provider").value);
  $("#site-category").value = site?.categoryId ?? "";
  $("#site-schedule").value = site?.scheduleMinutes ?? "";
  $("#site-tags").value = site?.tags?.join(", ") ?? "";
  $("#site-enabled").checked = site?.enabled ?? true;
  $("#credential-email").value = "";
  $("#credential-password").value = "";
  $("#credential-access-token").value = "";
  $("#credential-user-id").value = "";
  updateCredentialFields();
  $("#site-dialog").showModal();
}

async function saveSite(event) {
  event.preventDefault();
  const id = $("#site-id").value;
  const body = {
    name: $("#site-name").value.trim(),
    baseUrl: $("#site-url").value.trim(),
    providerId: $("#site-provider").value,
    authMode: $("#site-auth-mode").value,
    categoryId: $("#site-category").value || null,
    scheduleMinutes: $("#site-schedule").value || null,
    tags: splitTags($("#site-tags").value),
    enabled: $("#site-enabled").checked
  };
  let saved = await api(id ? `/api/sites/${id}` : "/api/sites", { method: id ? "PATCH" : "POST", body });
  const credentialBody = pendingCredentialBody(body.authMode);
  if (credentialBody) {
    saved = await api(`/api/sites/${saved.id}/credentials`, { method: "PUT", body: credentialBody });
  } else if (["public", "edge-profile"].includes(body.authMode) && state.editingSite?.credentialConfigured) {
    saved = await api(`/api/sites/${saved.id}/credentials`, { method: "DELETE" });
  }
  $("#site-dialog").close();
  showToast(id ? "站点已更新" : "站点已添加，请完成首次登录");
  await Promise.all([loadReferenceData(), loadSites(), loadRates()]);
}

async function bulkAddSites(event) {
  event.preventDefault();
  const sites = $("#bulk-sites").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, baseUrl, tags = ""] = line.split("|").map((part) => part.trim());
    return { name: name || hostname(baseUrl), baseUrl, tags: splitTags(tags) };
  });
  const result = await api("/api/sites/bulk", { method: "POST", body: { sites }, accept: [201, 207] });
  $("#bulk-dialog").close();
  $("#bulk-sites").value = "";
  showToast(`已添加 ${result.items.length} 个站点${result.errors.length ? `，${result.errors.length} 个失败` : ""}`);
  await Promise.all([loadReferenceData(), loadSites()]);
}

async function refreshAllSites() {
  const button = $("#refresh-all");
  await withButton(button, async () => {
    const data = await api("/api/sites?enabled=true&page=1&pageSize=200");
    const results = await Promise.allSettled(data.items.map((site) => api(`/api/sites/${site.id}/refresh`, { method: "POST" })));
    const failed = results.filter((item) => item.status === "rejected").length;
    showToast(`已刷新 ${results.length - failed}/${results.length} 个站点${failed ? `，${failed} 个失败` : ""}`);
  });
  await Promise.all([loadRates(), state.view === "sites" ? loadSites() : Promise.resolve()]);
}

async function loadSettings() {
  const [, , keyStatus] = await Promise.all([loadStatus(), loadReferenceData(), api("/api/settings/api-key")]);
  $("#api-key-status").textContent = keyStatus.configured ? "API Key 已配置" : "尚未配置 API Key";
}

async function rotateApiKey() {
  if (!confirm("生成新 API Key？旧 Key 会立即失效。")) return;
  const result = await api("/api/settings/api-key", { method: "POST" });
  $("#api-key-output").value = result.apiKey;
  $("#api-key-result").hidden = false;
  $("#api-key-status").textContent = "API Key 已配置";
  showToast("新 API Key 已生成");
}

async function exportJson(event) {
  await withButton(event.currentTarget, () => downloadArtifact("/api/exports/data.json"));
  showToast("JSON 数据已导出");
}

async function exportCsv(event) {
  await withButton(event.currentTarget, () => downloadArtifact("/api/exports/rates.csv"));
  showToast("CSV 数据已导出");
}

async function exportEncryptedBackup(event) {
  event.preventDefault();
  const password = $("#backup-password").value;
  const confirmation = $("#backup-password-confirm").value;
  try {
    if (password.length < 10) throw new Error("备份密码至少 10 个字符");
    if (password !== confirmation) throw new Error("两次输入的备份密码不一致");
    await withButton($("#export-encrypted-backup"), () => downloadArtifact("/api/exports/encrypted-backup", {
      method: "POST",
      body: { password }
    }));
    showToast("完整加密备份已导出");
  } finally {
    $("#backup-password").value = "";
    $("#backup-password-confirm").value = "";
  }
}

async function downloadArtifact(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `导出失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "export.bin";
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function clearChangeSiteFilter() {
  state.changeSiteId = null;
  $("#change-site-label").hidden = true;
  $("#clear-change-site").hidden = true;
  await loadChanges();
}

function handleProviderChange() {
  $("#site-auth-mode").value = defaultAuthMode($("#site-provider").value);
  updateCredentialFields();
}

function updateCredentialFields() {
  const mode = $("#site-auth-mode").value;
  $("#sub2api-credentials").hidden = mode !== "sub2api-password";
  $("#newapi-credentials").hidden = mode !== "newapi-token";
  $("#credential-state").textContent = state.editingSite?.credentialConfigured
    ? `已配置凭据：${state.editingSite.authUsername || "已加密保存"}`
    : mode === "sub2api-password" || mode === "newapi-token" ? "尚未配置凭据" : "";
}

function pendingCredentialBody(authMode) {
  if (authMode === "sub2api-password") {
    const email = $("#credential-email").value.trim();
    const password = $("#credential-password").value;
    if (!email && !password) return null;
    if (!email || !password) throw new Error("邮箱和密码必须同时填写");
    return { authMode, email, password };
  }
  if (authMode === "newapi-token") {
    const accessToken = $("#credential-access-token").value.trim();
    const userId = $("#credential-user-id").value.trim();
    if (!accessToken && !userId) return null;
    if (!accessToken || !userId) throw new Error("Access Token 和用户 ID 必须同时填写");
    return { authMode, accessToken, userId };
  }
  return null;
}

function defaultAuthMode(providerId) {
  if (providerId === "newapi") return "public";
  if (providerId === "sub2api") return "sub2api-password";
  return "edge-profile";
}

async function saveGlobalSchedule(event) {
  event.preventDefault();
  await api("/api/settings/schedule", { method: "PUT", body: { minutes: Number($("#global-schedule").value) } });
  showToast("默认采集频率已保存");
}

async function addCategory(event) {
  event.preventDefault();
  await api("/api/categories", {
    method: "POST",
    body: { name: $("#category-name").value.trim(), scheduleMinutes: $("#category-schedule").value || null }
  });
  event.target.reset();
  await loadReferenceData();
  showToast("分类已添加");
}

async function handleCategoryAction(event) {
  const button = event.target.closest('button[data-action="delete-category"]');
  if (!button) return;
  if (!confirm("删除该分类？站点会变为未分类。")) return;
  await api(`/api/categories/${button.dataset.id}`, { method: "DELETE" });
  await loadReferenceData();
}

function renderCategories() {
  $("#category-list").innerHTML = state.categories.length
    ? state.categories.map((item) => `<div><span><strong>${escapeHtml(item.name)}</strong><small>${item.siteCount} 个站点 · ${item.scheduleMinutes ? `${item.scheduleMinutes} 分钟` : "继承全局"}</small></span><button class="danger" type="button" data-action="delete-category" data-id="${item.id}" aria-label="删除 ${escapeAttr(item.name)}">×</button></div>`).join("")
    : '<p class="empty-note">暂无分类</p>';
}

function changeRatePage(delta) {
  state.rates.page = Math.max(1, state.rates.page + delta);
  loadRates();
}

function fillOptions(selector, items, emptyLabel, mapper) {
  const select = $(selector);
  const current = select.value;
  select.innerHTML = `<option value="">${emptyLabel}</option>${items.map((item) => {
    const [value, label] = mapper(item);
    return `<option value="${escapeAttr(value)}">${escapeHtml(label)}</option>`;
  }).join("")}`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function mergePlatformOptions(platforms) {
  const select = $("#platform-filter");
  const current = select.value;
  const values = [...new Set([...$$('#platform-filter option').map((option) => option.value).filter(Boolean), ...platforms])].sort();
  select.innerHTML = '<option value="">全部平台</option>' + values.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("");
  select.value = current;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? {} : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  if (response.status === 204) return null;
  const data = await response.json();
  const accepted = options.accept ?? [200, 201];
  if (!accepted.includes(response.status)) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

async function withButton(button, action) {
  const original = button.textContent;
  button.disabled = true;
  button.classList.add("loading");
  try { return await action(); }
  finally { button.disabled = false; button.classList.remove("loading"); button.textContent = original; }
}

function safeHandler(handler) {
  return (event) => {
    Promise.resolve(handler(event)).catch(showError);
  };
}

function setLoading(loading, target) {
  state.loading = loading;
  document.body.dataset.loading = loading ? target : "";
}

function showError(error) { showToast(`错误：${error.message || "操作失败"}`, true); }
function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, error ? 7000 : 3500);
}

function renderTableError(selector, colspan, message) {
  $(selector).innerHTML = `<tr class="empty error-state"><td colspan="${colspan}">${escapeHtml(message)}</td></tr>`;
}

function authBadge(status) {
  const map = { valid: ["有效", "success"], login_required: ["需要登录", "danger"], unknown: ["未验证", "neutral"] };
  const [label, kind] = map[status] ?? [status, "neutral"];
  return badge(label, kind);
}
function authModeLabel(mode) {
  return { public: "公开", "sub2api-password": "账号密码", "newapi-token": "Access Token", "edge-profile": "Edge" }[mode] ?? mode;
}
function changeTypeLabel(type) {
  return {
    group_added: "新增分组", group_removed: "删除分组", ratio_changed: "倍率变化",
    desc_changed: "说明变化", status_changed: "状态变化", subscription_type_changed: "订阅变化",
    billing_type_changed: "计费变化", rpm_limit_changed: "RPM 变化", is_exclusive_changed: "专属属性变化",
    limits_changed: "额度变化", peak_rule_changed: "峰值规则变化", group_name_changed: "分组名称变化",
    platform_changed: "平台变化"
  }[type] ?? type;
}
function formatChangeValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
function formatPercent(value) { return `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(2)}%`; }
function statusBadge(status) { return badge(status === "active" ? "active" : status, status === "active" ? "success" : "danger"); }
function badge(label, kind = "accent") { return `<span class="badge ${kind}">${escapeHtml(label)}</span>`; }
function formatRate(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toString(); }
function formatDate(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function hostname(value) { try { return new URL(value).hostname; } catch { return value || ""; } }
function splitTags(value) { return [...new Set(String(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean))]; }
function debounce(fn, wait) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function escapeAttr(value) { return escapeHtml(value); }
