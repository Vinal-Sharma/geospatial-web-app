/* script.js
   Full app logic for the Geospatial Dashboard
   - Requires libs loaded in index.html:
     Leaflet, MarkerCluster, shp.js, geotiff, georaster, georaster-layer-for-leaflet, PapaParse
*/

/* ----------------------- Helpers & UI ----------------------- */
const statusBox = document.getElementById('status');
function setStatus(text, color) {
  statusBox.innerText = text;
  statusBox.style.color = color || '';
}

/* Theme toggle */
const themeToggle = document.getElementById('themeToggle');
themeToggle.addEventListener('click', () => {
  const body = document.body;
  const current = body.getAttribute('data-theme') || 'dark';
  body.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
  setStatus('Theme: ' + (current === 'dark' ? 'light' : 'dark'));
});

/* ----------------------- Map & Layers ----------------------- */
const map = L.map('map', { preferCanvas: true }).setView([20, 78], 5);

/* Basemaps */
const base_osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const base_esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
const base_stamen = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg', { maxZoom: 18, attribution: 'Stamen' });

base_osm.addTo(map); // default

/* Overlays / state */
let uploadedLayerGroup = L.markerClusterGroup(); // points from CSV/GeoJSON/SHP
uploadedLayerGroup.addTo(map);

let rasterLayer = null;   // GeoTIFF layer
let shpGeoJsonLayer = null;
let routeLine = null;
let areaPolygon = null;
let areaMode = false;
let areaPoints = [];
let nearbyLayer = L.layerGroup();
let searchMarker = null;
let trackerMarker = null;
let distMarkers = [];

/* Bind basemap select */
document.getElementById('basemapSelect').addEventListener('change', (e) => {
  const key = e.target.value;
  setBasemap(key);
});

function setBasemap(key) {
  [base_osm, base_esri, base_stamen].forEach(l => map.removeLayer(l));
  if (key === 'osm') base_osm.addTo(map);
  else if (key === 'sat') base_esri.addTo(map);
  else if (key === 'terrain') base_stamen.addTo(map);
  setStatus('Basemap: ' + key.toUpperCase(), 'green');
}

/* ----------------------- Geocoding (Photon) ----------------------- */
async function geocodeOne(query) {
  if (!query) return null;
  try {
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`);
    const data = await res.json();
    if (data.features && data.features.length) {
      const coords = data.features[0].geometry.coordinates; // [lon,lat]
      return { lon: coords[0], lat: coords[1], name: data.features[0].properties.name || query };
    } else return null;
  } catch (err) {
    console.error('Geocode error', err);
    return null;
  }
}

/* ----------------------- Search & Track ----------------------- */
document.getElementById('searchBtn').addEventListener('click', async () => {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) { setStatus('Type a place to search', 'orange'); return; }
  setStatus('Searching...');
  const r = await geocodeOne(q);
  if (!r) { setStatus('Place not found', 'red'); return; }
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([r.lat, r.lon]).addTo(map).bindPopup(r.name).openPopup();
  map.setView([r.lat, r.lon], 12);
  setStatus('Found: ' + (r.name || q), 'green');
});

document.getElementById('trackMe').addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Geolocation not supported', 'red'); return; }
  setStatus('Getting current position...');
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    if (trackerMarker) map.removeLayer(trackerMarker);
    trackerMarker = L.marker([lat, lon]).addTo(map).bindPopup('You are here').openPopup();
    map.setView([lat, lon], 14);
    setStatus('Tracked your location', 'green');
  }, (err) => {
    setStatus('Unable to get location', 'red');
  });
});

/* ----------------------- Upload (CSV / GeoJSON / SHP.zip / TIF) ----------------------- */
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');

fileInput.addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  fileInfo.innerText = f.name;
  const ext = f.name.split('.').pop().toLowerCase();

  setStatus('Processing ' + f.name + ' ...');

  try {
    if (ext === 'csv') {
      // parse CSV via PapaParse
      Papa.parse(f, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          uploadedLayerGroup.clearLayers();
          let count = 0;
          const rows = res.data;
          rows.forEach(row => {
            const keys = Object.keys(row);
            let latKey = keys.find(k => k.toLowerCase().includes('lat'));
            let lonKey = keys.find(k => k.toLowerCase().includes('lon'));
            if (!latKey || !lonKey) {
              latKey = keys.find(k => k.toLowerCase().includes('latitude'));
              lonKey = keys.find(k => k.toLowerCase().includes('longitude'));
            }
            if (latKey && lonKey) {
              const lat = parseFloat(row[latKey]), lon = parseFloat(row[lonKey]);
              if (!isNaN(lat) && !isNaN(lon)) {
                const popup = Object.entries(row).map(([k, v]) => `<b>${k}:</b> ${v}`).join('<br/>');
                L.marker([lat, lon]).bindPopup(popup).addTo(uploadedLayerGroup);
                count++;
              }
            }
          });
          try { map.fitBounds(uploadedLayerGroup.getBounds()); } catch(e){}
          setStatus(`CSV loaded: ${count} points`, 'green');
        },
        error: (err) => { console.error(err); setStatus('CSV parse error', 'red'); }
      });

    } else if (ext === 'geojson' || ext === 'json') {
      const text = await f.text();
      const geo = JSON.parse(text);
      uploadedLayerGroup.clearLayers();
      const geoLayer = L.geoJSON(geo, {
        onEachFeature: (feat, layer) => {
          if (feat.properties) {
            const popup = Object.entries(feat.properties).map(([k, v]) => `<b>${k}:</b> ${v}`).join('<br/>');
            layer.bindPopup(popup);
          }
        },
        pointToLayer: (feature, latlng) => L.marker(latlng)
      });
      uploadedLayerGroup.addLayer(geoLayer);
      try { map.fitBounds(geoLayer.getBounds()); } catch(e){}
      setStatus('GeoJSON loaded', 'green');

    } else if (ext === 'zip' || ext === 'shp') {
      // shapefile (zipped)
      // shp.js can accept a Blob/ArrayBuffer; returns GeoJSON
      setStatus('Reading shapefile (this may take a moment)...');
      const arrayBuffer = await f.arrayBuffer();
      shp(arrayBuffer).then(geojson => {
        // clear previous
        uploadedLayerGroup.clearLayers();
        // If multiple feature collections, shp returns object with layers; handle generically
        let gj = geojson;
        if (geojson.type === undefined && typeof geojson === 'object') {
          // shp may return { 'layerName': FeatureCollection, ... }
          // merge layers
          let features = [];
          Object.values(geojson).forEach(layer => {
            if (layer && layer.features) features = features.concat(layer.features);
          });
          gj = { type: 'FeatureCollection', features: features };
        }
        shpGeoJsonLayer = L.geoJSON(gj, {
          onEachFeature: (feat, layer) => {
            if (feat.properties) {
              const popup = Object.entries(feat.properties).map(([k, v]) => `<b>${k}:</b> ${v}`).join('<br/>');
              layer.bindPopup(popup);
            }
          }
        }).addTo(uploadedLayerGroup);
        try { map.fitBounds(uploadedLayerGroup.getBounds()); } catch (e) {}
        setStatus('Shapefile loaded', 'green');
      }).catch(err => {
        console.error(err);
        setStatus('Error reading shapefile', 'red');
      });

    } else if (ext === 'tif' || ext === 'tiff') {
      // GeoTIFF
      setStatus('Reading GeoTIFF (may take a moment)...');
      const arrayBuffer = await f.arrayBuffer();
      try {
        // parseGeoraster should be provided by georaster bundle
        const georaster = await parseGeoraster(arrayBuffer);
        if (rasterLayer) map.removeLayer(rasterLayer);
        rasterLayer = new GeoRasterLayer({
          georaster,
          opacity: 0.8,
          resolution: 256
        });
        rasterLayer.addTo(map);
        // fit map to raster bounds
        const bounds = rasterLayer.getBounds ? rasterLayer.getBounds() : null;
        if (bounds) map.fitBounds(bounds);
        setStatus('GeoTIFF raster loaded', 'green');
      } catch (err) {
        console.error(err);
        setStatus('Error loading GeoTIFF', 'red');
      }

    } else {
      setStatus('Unsupported file type. Use CSV, GeoJSON, SHP(zip) or TIF', 'red');
    }
  } catch (err) {
    console.error(err);
    setStatus('File processing error', 'red');
  }
});

/* ----------------------- Distance ----------------------- */
document.getElementById('distBtn').addEventListener('click', async () => {
  const A = document.getElementById('distA').value.trim();
  const B = document.getElementById('distB').value.trim();
  if (!A || !B) { setStatus('Enter two places', 'orange'); return; }
  setStatus('Finding coordinates...');
  const a = await geocodeOne(A);
  const b = await geocodeOne(B);
  if (!a || !b) { setStatus('Could not find one or both places', 'red'); return; }
  const d = haversine(a.lat, a.lon, b.lat, b.lon);
  setStatus(`Distance: ${d.toFixed(2)} km`, 'green');
  // show markers
  distMarkers.forEach(m => map.removeLayer(m));
  distMarkers = [
    L.marker([a.lat, a.lon]).addTo(map).bindPopup(A),
    L.marker([b.lat, b.lon]).addTo(map).bindPopup(B)
  ];
  try { map.fitBounds(L.featureGroup(distMarkers).getBounds(), { padding: [40, 40] }); } catch (e) {}
});

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ----------------------- Area Drawing ----------------------- */
document.getElementById('areaStart').addEventListener('click', () => {
  areaMode = true; areaPoints = [];
  if (areaPolygon) { map.removeLayer(areaPolygon); areaPolygon = null; }
  setStatus('Area mode: click on map to add polygon points');
});
document.getElementById('areaReset').addEventListener('click', () => {
  areaMode = false; areaPoints = [];
  if (areaPolygon) { map.removeLayer(areaPolygon); areaPolygon = null; }
  setStatus('Area cleared');
});

map.on('click', (e) => {
  if (!areaMode) return;
  areaPoints.push([e.latlng.lat, e.latlng.lng]);
  if (areaPolygon) map.removeLayer(areaPolygon);
  areaPolygon = L.polygon(areaPoints, { color: '#a87dff', fillOpacity: 0.12 }).addTo(map);
  if (areaPoints.length >= 3) {
    const area = polygonArea(areaPoints);
    setStatus(`Polygon area: ${area.toFixed(3)} sq km`, 'green');
  } else {
    setStatus(`Points: ${areaPoints.length} (need ≥3)`);
  }
});

/* spherical polygon area approx */
function polygonArea(coords) {
  const R = 6371;
  let sum = 0;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const lat1 = coords[i][0] * Math.PI / 180, lon1 = coords[i][1] * Math.PI / 180;
    const lat2 = coords[j][0] * Math.PI / 180, lon2 = coords[j][1] * Math.PI / 180;
    sum += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(sum * R * R / 2);
}

/* ----------------------- Routing (OSRM) ----------------------- */
document.getElementById('routeBtn').addEventListener('click', async () => {
  const s = document.getElementById('routeStart').value.trim();
  const e = document.getElementById('routeEnd').value.trim();
  if (!s || !e) { setStatus('Enter route start and end', 'orange'); return; }
  setStatus('Geocoding...');
  const S = await geocodeOne(s);
  const E = await geocodeOne(e);
  if (!S || !E) { setStatus('Could not geocode start or end', 'red'); return; }
  setStatus('Requesting route...');
  const url = `https://router.project-osrm.org/route/v1/driving/${S.lon},${S.lat};${E.lon},${E.lat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.routes || !data.routes.length) { setStatus('No route found', 'red'); return; }
    const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    if (routeLine) map.removeLayer(routeLine);
    routeLine = L.polyline(coords, { color: '#6b5cff', weight: 4 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
    setStatus(`Route: ${(data.routes[0].distance / 1000).toFixed(2)} km`, 'green');
  } catch (err) {
    console.error(err); setStatus('Routing error', 'red');
  }
});

/* ----------------------- Nearby (Nominatim bounding box) ----------------------- */
document.getElementById('nearbyBtn').addEventListener('click', async () => {
  const term = document.getElementById('nearbyTerm').value.trim();
  if (!term) { setStatus('Enter a search term (e.g., cafe)', 'orange'); return; }
  // need base point
  let base;
  if (trackerMarker) base = trackerMarker.getLatLng();
  else if (searchMarker) base = searchMarker.getLatLng();
  else {
    setStatus('Track yourself or search a place first', 'orange');
    return;
  }
  const lat = base.lat, lon = base.lng;
  setStatus('Searching nearby...');
  const box = `${lon - 0.08},${lat + 0.08},${lon + 0.08},${lat - 0.08}`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(term)}&limit=25&viewbox=${encodeURIComponent(box)}&bounded=1`;
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    nearbyLayer.clearLayers();
    let count = 0;
    data.forEach(p => {
      const m = L.marker([p.lat, p.lon]).bindPopup(p.display_name);
      nearbyLayer.addLayer(m);
      count++;
    });
    if (count) {
      nearbyLayer.addTo(map);
      map.fitBounds(nearbyLayer.getBounds(), { padding: [40, 40] });
    }
    setStatus(`${count} places found`, 'green');
  } catch (err) {
    console.error(err); setStatus('Nearby search failed', 'red');
  }
});

/* ----------------------- Clear Everything ----------------------- */
document.getElementById('clearAll').addEventListener('click', clearEverything);
function clearEverything() {
  if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  if (trackerMarker) { map.removeLayer(trackerMarker); trackerMarker = null; }
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (areaPolygon) { map.removeLayer(areaPolygon); areaPolygon = null; areaPoints = []; }
  if (rasterLayer) { map.removeLayer(rasterLayer); rasterLayer = null; }
  uploadedLayerGroup.clearLayers();
  nearbyLayer.clearLayers();
  distMarkers.forEach(m => map.removeLayer(m)); distMarkers = [];
  setStatus('Cleared map', 'green');
}

/* ----------------------- Small UX / bindings ----------------------- */
// Enter to search
document.getElementById('searchInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') document.getElementById('searchBtn').click(); });

/* initial status */
setStatus('Ready');

/* ----------------------- End of script.js ----------------------- */
