let map;
let marker;
let iconsConfigured = false; 
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
  
  if (map && marker && locationData && locationData.latitude && locationData.longitude) {
    const latLng = [locationData.latitude, locationData.longitude];
    map.setView(latLng, 13);
    marker.setLatLng(latLng);
    marker.setOpacity(1);
    const popupContent = '<b>' + locationData.country + '</b><br>纬度: ' + locationData.latitude + '<br>经度: ' + locationData.longitude;
    marker.bindPopup(popupContent).openPopup();
  }
});

initMap();