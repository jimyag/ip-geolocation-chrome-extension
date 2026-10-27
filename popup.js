const countryEl = document.getElementById('country');
const latitudeEl = document.getElementById('latitude');
const longitudeEl = document.getElementById('longitude');
const updateTimeEl = document.getElementById('updateTime');
const refreshBtn = document.getElementById('refresh-btn');
const dismissFailureBtn = document.getElementById('dismiss-failure');
let displayedFailure;

function showFailure(message) {
  document.getElementById('status').textContent = message;
}

function formatValue(value) {
  return value ?? 'N/A';
}

function updateUI(locationData) {
  if (!locationData) {
    [countryEl, latitudeEl, longitudeEl, updateTimeEl].forEach(el => el.textContent = '暂无数据');
    return;
  }
  countryEl.textContent = locationData.country || 'N/A';
  document.getElementById('ip').textContent = locationData.ip || 'N/A';
  document.getElementById('source').textContent = locationData.source || 'N/A';
  latitudeEl.textContent = formatValue(locationData.latitude);
  longitudeEl.textContent = formatValue(locationData.longitude);
  updateTimeEl.textContent = formatValue(locationData.updateTime);

}

async function displayLocation() {
  const { manualLocation, ipInfo, lastLocation: cachedLocation, health, lastFailure } = await chrome.storage.local.get(['manualLocation', 'ipInfo', 'lastLocation', 'health', 'lastFailure']);
  const lastLocation = manualLocation || ipInfo || (cachedLocation?.country === '中国 (隐私保护)' ? null : cachedLocation);
  updateUI(lastLocation);
  if (!lastLocation) {
    document.getElementById('ip').textContent = '暂无数据';
    document.getElementById('source').textContent = '暂无数据';
  }
  document.getElementById('status').textContent = [health?.message, lastFailure && `最近失败（${lastFailure.time}）：${lastFailure.message}`].filter(Boolean).join('\n');
  displayedFailure = lastFailure?.id;
  dismissFailureBtn.hidden = !lastFailure;
  const tabs = await chrome.tabs.query({});
  const deferred = tabs.filter(tab => /^https?:/.test(tab.url || '') &&
    (tab.frozen || tab.discarded || tab.status === 'unloaded'));
  document.getElementById('deferred-status').textContent = deferred.length
    ? `${deferred.length} 个页面被冻结或尚未加载，恢复后自动更新定位。` : '';
}

async function performAction(request) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach(button => { if (button.id !== 'dismiss-failure') button.disabled = true; });
  try {
    const response = await chrome.runtime.sendMessage(request);
    await displayLocation();
    if (!response?.ok) showFailure(response?.error || '操作失败');
  } catch (error) {
    showFailure(`操作失败：${error.message}`);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

refreshBtn.addEventListener('click', () => performAction({ action: 'manualUpdate' }));
document.getElementById('manual-form').addEventListener('submit', event => {
  event.preventDefault();
  performAction({ action: 'setManualLocation',
    latitude: document.getElementById('manual-latitude').valueAsNumber,
    longitude: document.getElementById('manual-longitude').valueAsNumber });
});
document.getElementById('automatic-btn').addEventListener('click', () => performAction({ action: 'useAutomaticLocation' }));
dismissFailureBtn.addEventListener('click', () => {
  performAction({ action: 'dismissFailure', id: displayedFailure });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') displayLocation().catch(error => showFailure(error.message));
});
document.addEventListener('DOMContentLoaded', () => displayLocation().catch(error => showFailure(error.message)));
