const API_ENDPOINTS = ['https://ipwho.is/', 'https://api.ip.sb/geoip', 'https://ip9.com.cn/get'];
const REQUEST_TIMEOUT_MS = 8000;
const ALARM_NAME = 'updateGeoAlarm';
const INJECTION_TIMEOUT_MS = 8000;
let failureSequence = 0;

async function reportFailure(message) {
  const failure = { message, time: new Date().toLocaleString(), id: `${Date.now()}-${failureSequence++}` };
  await chrome.storage.local.set({ lastFailure: failure }).catch(console.error);
  await chrome.action.setBadgeText({ text: '!' }).catch(console.error);
  await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(console.error);
  await chrome.notifications.create(`location-error-${failure.id}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icon.png'),
    title: 'IP定位操作失败', message, requireInteraction: true
  }).then(() => chrome.storage.local.remove('notificationError')).catch(async error => {
    console.error('发送通知失败:', error);
    await chrome.storage.local.set({ notificationError: error.message }).catch(console.error);
  });
}

function hasValidCoordinates(location) {
  return location &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180;
}

function normalizeLocation(data) {
  if (!data || data.success === false || (data.ret !== undefined && data.ret !== 200)) {
    throw new Error('接口返回查询失败');
  }
  const value = data.data || data;
  const lat = value.latitude ?? value.lat;
  const lon = value.longitude ?? value.lng;
  const location = {
    ip: value.ip,
    latitude: ['string', 'number'].includes(typeof lat) && String(lat).trim() !== '' ? Number(lat) : NaN,
    longitude: ['string', 'number'].includes(typeof lon) && String(lon).trim() !== '' ? Number(lon) : NaN,
    country: (value.country_code || '').toUpperCase()
  };
  if (!hasValidCoordinates(location) || typeof location.ip !== 'string' || !location.ip.trim() ||
      !/^[A-Z]{2}$/.test(location.country)) throw new Error('接口缺少有效的 IP、国家或经纬度');
  return location;
}

async function fetchLocation() {
  const errors = [];
  for (const endpoint of API_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ...normalizeLocation(await response.json()), source: endpoint, errors };
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
      await reportFailure(`获取 IP 定位失败：${endpoint}\n${error.message}。${endpoint === API_ENDPOINTS.at(-1) ? '已无备用接口。' : '正在尝试备用接口。'}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function reportHealth(state, message) {
  await chrome.storage.local.set({ health: { state, message, checkedAt: new Date().toLocaleString() } });
  const { lastFailure } = await chrome.storage.local.get('lastFailure');
  await chrome.action.setBadgeText({ text: state === 'ok' && !lastFailure ? '' : '!' });
}

let pendingUpdate;

const spooferFunction = (latitude, longitude) => {
  navigator.geolocation.getCurrentPosition = (successCallback, errorCallback, options) => {
    successCallback({
      coords: {
        latitude: latitude,
        longitude: longitude,
        accuracy: 20 + Math.random() * 10,
        altitude: null, altitudeAccuracy: null, heading: null, speed: null
      },
      timestamp: Date.now()
    });
  };
  navigator.geolocation.watchPosition = (successCallback, errorCallback, options) => {
    navigator.geolocation.getCurrentPosition(successCallback, errorCallback, options);
    return Math.floor(Math.random() * 10000);
  };
};

async function injectScript(tabId) {
  let timer;
  try {
    const { manualLocation, ipInfo, lastLocation: cachedLocation } = await chrome.storage.local.get(['manualLocation', 'ipInfo', 'lastLocation']);
    const lastLocation = manualLocation || (hasValidCoordinates(ipInfo) ? ipInfo : cachedLocation);
    if (lastLocation?.country === '中国 (隐私保护)') return;
    if (hasValidCoordinates(lastLocation)) {
      await Promise.race([chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        func: spooferFunction,
        args: [lastLocation.latitude, lastLocation.longitude],
        injectImmediately: true,
        world: 'MAIN'
      }), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('网页定位注入等待超过 8 秒')), INJECTION_TIMEOUT_MS);
      })]);
    }
  } catch (error) {
    await reportFailure(`更新网页位置失败（标签页 ${tabId}）：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function updateAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter(tab => tab.id != null && /^https?:/.test(tab.url || '')).map(tab => injectScript(tab.id)));
  } catch (error) {
    await reportFailure(`更新网页位置失败：${error.message}`);
  }
}

async function performUpdate() {
  try {
    const { manualLocation } = await chrome.storage.local.get('manualLocation');
    if (hasValidCoordinates(manualLocation)) {
      updateAllTabs().catch(console.error);
      await reportHealth('ok', '正在使用手动经纬度，IP 自动定位已暂停');
      return { ok: true };
    }
    const { ipInfo: cachedIpInfo, lastLocation } = await chrome.storage.local.get(['ipInfo', 'lastLocation']);
    if (hasValidCoordinates(cachedIpInfo) && (!lastLocation ||
        lastLocation.latitude !== cachedIpInfo.latitude || lastLocation.longitude !== cachedIpInfo.longitude)) {
      await chrome.storage.local.set({ lastLocation: cachedIpInfo });
      updateAllTabs().catch(console.error);
    } else if (lastLocation?.country === '中国 (隐私保护)') {
      await chrome.storage.local.remove('lastLocation');
    }
    const { errors, ...ipInfo } = await fetchLocation();
    const locationToSet = {
      ...ipInfo,
      updateTime: new Date().toLocaleString()
    };
    await chrome.storage.local.set({
      ipInfo: { ...ipInfo, updateTime: locationToSet.updateTime }, lastLocation: locationToSet
    });
    await chrome.storage.local.remove('lastError');
    // 个别页面的 frame 注入可能一直等待，不能阻塞刷新响应。
    updateAllTabs().catch(console.error);
    await reportHealth(errors.length ? 'backup' : 'ok', errors.length
      ? `首选接口不可用，已切换到 ${ipInfo.source}` : '定位更新正常');
    return { ok: true };
  } catch (error) {
    console.error('后台更新地理位置失败:', error);
    const { lastLocation } = await chrome.storage.local.get('lastLocation');
    const message = `更新位置失败：${error.message}\n${hasValidCoordinates(lastLocation) ? '继续使用上次成功的缓存位置，可能已过时。' : '尚无可用的位置缓存。'}可在扩展弹窗设置手动经纬度。`;
    await reportFailure(message);
    await reportHealth('error', message);
    await chrome.storage.local.set({ lastError: error.message });
    return { ok: false, error: error.message };
  }
}

function updateGeolocation() {
  if (!pendingUpdate) pendingUpdate = performUpdate().catch(async error => {
    await reportFailure(`更新位置失败：${error.message}`);
    return { ok: false, error: error.message };
  }).finally(() => { pendingUpdate = undefined; });
  return pendingUpdate;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && /^https?:/.test(tab.url || '')) {
    injectScript(tabId);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    updateGeolocation();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!['manualUpdate', 'setManualLocation', 'useAutomaticLocation', 'dismissFailure'].includes(request.action)) return;
  (async () => {
    try {
      // 等待进行中的自动刷新结束，避免它覆盖刚保存的手动设置。
      if (request.action !== 'manualUpdate' && pendingUpdate) await pendingUpdate;
      if (request.action === 'setManualLocation') {
        const location = { latitude: request.latitude, longitude: request.longitude };
        if (!hasValidCoordinates(location)) throw new Error('纬度须为 -90 到 90，经度须为 -180 到 180 的数字');
        await chrome.storage.local.set({ manualLocation: { ...location, country: '手动设置', source: '手动设置', updateTime: new Date().toLocaleString() } });
        return await updateGeolocation();
      }
      if (request.action === 'useAutomaticLocation') await chrome.storage.local.remove('manualLocation');
      if (request.action === 'dismissFailure') {
        const { lastFailure, health } = await chrome.storage.local.get(['lastFailure', 'health']);
        if (lastFailure?.id === request.id) {
          await chrome.storage.local.remove(['lastFailure', 'notificationError']);
          await chrome.action.setBadgeText({ text: health?.state === 'ok' ? '' : '!' });
        }
        return { ok: true };
      }
      return await updateGeolocation();
    } catch (error) {
      await reportFailure(`操作失败：${error.message}`);
      return { ok: false, error: error.message };
    }
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  updateGeolocation();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  updateGeolocation();
});
