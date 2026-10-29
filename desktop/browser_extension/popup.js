/**
 * popup.js - 伴侣感知扩展控制面板
 */

const chkEnabled = document.getElementById('chk-enabled');
const inpUrl = document.getElementById('inp-url');
const btnTest = document.getElementById('btn-test');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// 加载当前设置
chrome.storage.local.get(['enabled', 'serverUrl'], (items) => {
  if (items.enabled !== undefined) {
    chkEnabled.checked = items.enabled;
  }
  if (items.serverUrl) {
    inpUrl.value = items.serverUrl;
  }
  checkConnection(inpUrl.value);
});

// 开关保存
chkEnabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: chkEnabled.checked });
});

// 地址保存
inpUrl.addEventListener('change', () => {
  const url = inpUrl.value.trim().replace(/\/+$/, '');
  inpUrl.value = url;
  chrome.storage.local.set({ serverUrl: url });
});

// 测试连通性
btnTest.addEventListener('click', () => {
  const url = inpUrl.value.trim().replace(/\/+$/, '');
  checkConnection(url);
});

function checkConnection(baseUrl) {
  statusDot.className = 'dot';
  statusText.textContent = '检测连通中...';

  const checkUrl = `${baseUrl}/dsh-pet/state`;
  fetch(checkUrl, { method: 'GET' })
    .then(res => {
      if (res.ok) {
        statusDot.className = 'dot online';
        statusText.textContent = '伴侣服务已在线';
      } else {
        statusDot.className = 'dot offline';
        statusText.textContent = `服务响应异常 (${res.status})`;
      }
    })
    .catch(() => {
      statusDot.className = 'dot offline';
      statusText.textContent = '无法连接 (请确保伴侣运行中)';
    });
}
