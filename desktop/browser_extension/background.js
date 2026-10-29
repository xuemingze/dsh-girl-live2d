/**
 * background.js - DSH Live2D Pet 网页感知伴侣扩展
 * 
 * 职责：
 * 1. 监听浏览器标签页更新 (chrome.tabs.onUpdated)
 * 2. 过滤非标准协议 (chrome://, edge://, about:)
 * 3. 当页面加载完成时，将安全元数据 (URL + 标题) 通过本地回环 POST 推送给伴侣服务
 * 4. 严格遵循静默原则：服务未启动或网络不通时静默失败，绝不弹窗打扰
 */

const DEFAULT_SERVER_URL = 'http://127.0.0.1:19387';
let cachedSettings = {
  enabled: true,
  serverUrl: DEFAULT_SERVER_URL
};

// 初始化读取配置
chrome.storage.local.get(['enabled', 'serverUrl'], (items) => {
  if (items.enabled !== undefined) cachedSettings.enabled = items.enabled;
  if (items.serverUrl) cachedSettings.serverUrl = items.serverUrl;
});

// 监听配置变更
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.enabled) cachedSettings.enabled = changes.enabled.newValue;
    if (changes.serverUrl) cachedSettings.serverUrl = changes.serverUrl.newValue;
  }
});

// 记录最近处理过的 tabUrl，防止单页应用短时间内高频重复推送
const lastPushedUrls = new Map(); // tabId -> { url, ts }
const PUSH_DEBOUNCE_MS = 3000;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!cachedSettings.enabled) return;
  if (!tab || !tab.url) return;

  // 仅在页面加载完毕且为标准 Web 地址时推送
  if (changeInfo.status !== 'complete') return;
  if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) return;

  const now = Date.now();
  const last = lastPushedUrls.get(tabId);
  if (last && last.url === tab.url && (now - last.ts) < PUSH_DEBOUNCE_MS) {
    return;
  }
  lastPushedUrls.set(tabId, { url: tab.url, ts: now });

  // 构造推送包
  const payload = {
    url: tab.url,
    title: tab.title || '',
    tabId: tabId,
    timestamp: now
  };

  const endpoint = `${cachedSettings.serverUrl.replace(/\/+$/, '')}/dsh-pet/perception/web-event`;

  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }).catch(() => {
    // 静默失败：宿主伴侣未运行或端口不对时无需报错
  });
});

// 清理关闭的标签页缓存
chrome.tabs.onRemoved.addListener((tabId) => {
  lastPushedUrls.delete(tabId);
});
