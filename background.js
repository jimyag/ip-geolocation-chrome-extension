const API_URL = 'https://ors.de5.net/ip';
const ALARM_NAME = 'updateGeoAlarm';
const FALLBACK_LOCATION = {
  latitude: 0.00,
  longitude: 0.00,
  country: '中国 (隐私保护)'
};

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
  const { lastLocation } = await chrome.storage.local.get('lastLocation');
  if (lastLocation && lastLocation.latitude && lastLocation.longitude) {
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: spooferFunction,
      args: [lastLocation.latitude, lastLocation.longitude],
      injectImmediately: true,
      world: 'MAIN'
    }).catch(error => console.log(`无法注入到 Tab ${tabId}: ${error.message}`));
  }
}

async function updateAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      injectScript(tab.id);
    }
  }
}

async function updateGeolocation(forceUpdate = false) {
  try {
    const { lastLocation: oldLocation } = await chrome.storage.local.get('lastLocation');
    const response = await fetch(API_URL, { cache: 'no-store' });
    if (!response.ok) return;

    const data = await response.json();
    if (!data || !data.latitude || !data.longitude) return;

    const lat = parseFloat(data.latitude);
    const lon = parseFloat(data.longitude);
    if (isNaN(lat) || isNaN(lon)) return;

    let locationToSet;
    if (data.country === 'CN') {
      locationToSet = FALLBACK_LOCATION;
    } else {
      locationToSet = {
        latitude: lat,
        longitude: lon,
        country: data.country || 'Unknown'
      };
    }

    if (!forceUpdate && oldLocation &&
        locationToSet.latitude === oldLocation.latitude &&
        locationToSet.longitude === oldLocation.longitude) {
      return;
    }

    await chrome.storage.local.set({
      lastLocation: { ...locationToSet, updateTime: new Date().toLocaleString() }
    });

    console.log(`位置已更新为: ${locationToSet.country} (${locationToSet.latitude}, ${locationToSet.longitude})。正在更新所有标签页...`);
    await updateAllTabs();
  } catch (error) {
    console.error("后台更新地理位置失败:", error);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    injectScript(tabId);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    updateGeolocation();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "manualUpdate") {
    (async () => {
      await updateGeolocation(true);
      sendResponse({ status: "ok" });
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  updateGeolocation(true);
});
chrome.runtime.onStartup.addListener(() => {
  updateGeolocation(true);
});
