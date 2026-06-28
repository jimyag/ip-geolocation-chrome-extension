let map;
let marker;
let iconsConfigured = false; 

function hasValidCoordinates(locationData) {
  return locationData &&
    Number.isFinite(locationData.latitude) &&
    Number.isFinite(locationData.longitude);
}

function initMap() {
  map = L.map('map').setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
  marker = L.marker([0, 0], { opacity: 0 }).addTo(map);
}

window.addEventListener('message', event => {
  const payload = event.data;
  const locationData = payload.location;
  const iconUrls = payload.iconUrls;

  if (!iconsConfigured && iconUrls) {
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: iconUrls.iconRetinaUrl,
      iconUrl: iconUrls.iconUrl,
      shadowUrl: iconUrls.shadowUrl,
    });
    iconsConfigured = true;
  }
  
  if (map && marker && hasValidCoordinates(locationData)) {
    const latLng = [locationData.latitude, locationData.longitude];
    map.setView(latLng, 13);
    marker.setLatLng(latLng);
    marker.setOpacity(1);
    const popupContent = document.createElement('div');
    const countryEl = document.createElement('b');
    const coordinatesEl = document.createElement('div');

    countryEl.textContent = locationData.country || 'N/A';
    coordinatesEl.textContent = '纬度: ' + locationData.latitude + ' 经度: ' + locationData.longitude;
    popupContent.append(countryEl, coordinatesEl);

    marker.bindPopup(popupContent).openPopup();
  }
});

initMap();
