const countryEl = document.getElementById('country');
const latitudeEl = document.getElementById('latitude');
const longitudeEl = document.getElementById('longitude');
const updateTimeEl = document.getElementById('updateTime');
const refreshBtn = document.getElementById('refresh-btn');
const mapFrame = document.getElementById('map-frame');

function formatValue(value) {
  return value ?? 'N/A';
}

function updateUI(locationData) {
  if (!locationData) {
    [countryEl, latitudeEl, longitudeEl, updateTimeEl].forEach(el => el.textContent = '暂无数据');
    return;
  }
  countryEl.textContent = locationData.country || 'N/A';
  latitudeEl.textContent = formatValue(locationData.latitude);
  longitudeEl.textContent = formatValue(locationData.longitude);
  updateTimeEl.textContent = formatValue(locationData.updateTime);

  const payload = {
    location: locationData,
    iconUrls: {
      iconUrl: chrome.runtime.getURL('images/marker-icon.png'),
      iconRetinaUrl: chrome.runtime.getURL('images/marker-icon-2x.png'),
      shadowUrl: chrome.runtime.getURL('images/marker-shadow.png')
    }
  };
  
  mapFrame.onload = () => {
    mapFrame.contentWindow.postMessage(payload, '*');
  };

  if (mapFrame.contentWindow) {
    mapFrame.contentWindow.postMessage(payload, '*');
  }
}

function displayLocation() {
  chrome.storage.local.get('lastLocation', ({ lastLocation }) => {
    updateUI(lastLocation);
  });
}

refreshBtn.addEventListener('click', () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '刷新中...';

  chrome.runtime.sendMessage({ action: "manualUpdate" }, (response) => {
    if (response && response.status === "ok") {
      setTimeout(displayLocation, 500); 
    }
    refreshBtn.disabled = false;
    refreshBtn.textContent = '立即刷新';
  });
});

document.addEventListener('DOMContentLoaded', displayLocation);
