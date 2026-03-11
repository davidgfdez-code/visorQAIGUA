console.clear();
console.log("🟦 app.js carregat (AquaCheck)", new Date().toISOString());

const DATA_SECTORS = "./data/sectors.geojson";
const DATA_RESULTS = "./data/resultats.csv";

const WARN_RATIO = 0.8;

const CENTER = [41.045, 0.93]; // Vista inicial centrada entre Mont-roig y Miami
const START_ZOOM = 12; // Zoom inicial

const INDICADORS = [
  { key: "E. coli" },
  { key: "Clor lliure residual" },
  { key: "Terbolesa" },
  { key: "Nitrats" },
  { key: "pH" },
  { key: "Duresa" },
  { key: "Conductivitat" }
];

function normalizeText(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "") // BOM
    .replace(/"/g, "") // comillas
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // tildes
    .toUpperCase();
}

const NEUTRES = new Set([normalizeText("Clorurs"), normalizeText("Conductivitat")]); // Parámetros NEUTROS: no afectan al semáforo ni se remarcan en el popup
const CLORURS_KEY = normalizeText("Clorurs");
const COND_KEY = normalizeText("Conductivitat");

function sectorFromProps(props) { // GeoJSON con clave "sector"
  return props && props.sector ? String(props.sector) : "";
}

async function fetchJSON(url) {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} cargando ${url}`);
  return await resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} cargando ${url}`);
  return await resp.text();
}

function parseCSV(text) { // CSV simple
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((s) => s.trim().replace(/^\uFEFF/, ""));
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(",").map((s) => s.trim());
      const o = {};
      header.forEach((h, i) => (o[h] = cols[i] ?? ""));
      return o;
    });
}

function toNumber(x) {
  const s = String(x ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function formatData(iso) {
  if (!iso) return "—";

  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);

  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();

  return `${day}/${month}/${year}`;
}

// Semáforo APTA PER AL CONSUM o APTA PER AL CONSUM (amb incidències)
function estatDeFila(row) {
  const v = toNumber(row.valor);

  const hasMin = row.limit_min !== "" && row.limit_min != null;
  const hasMax = row.limit_max !== "" && row.limit_max != null;
  const min = hasMin ? toNumber(row.limit_min) : null;
  const max = hasMax ? toNumber(row.limit_max) : null;

  if (v === null) return "na";
  
  const p = normalizeText(row.parametre || ""); // Cloruros y Conductividad: siempre APTA
  if (NEUTRES.has(p)) return "ok";
 
  if (min !== null) {
    if (v < min) return "warn";
    if (max !== null && v > max) return "warn";
    return "ok";
  }

  if (max === null) return "ok"; //  Límite máximo
  if (max === 0) return v > 0 ? "warn" : "ok"; // E. coli tiene límite 0.
  if (v > max) return "warn";
  return "ok";
}

function colorSemafor(estat) {
  if (estat === "ok") return "#3A9B6A";
  if (estat === "warn") return "#B7791F";
  return "#7A8691";
}

function labelSemafor(estat) {
  if (estat === "warn") return "APTA PER AL CONSUM (amb incidències)";
  if (estat === "ok") return "APTA PER AL CONSUM";
  return "SENSE DADES";
}

function calcularSemaforSector(files) { // Regla: si está fuera de límite => EN SEGUIMENT
  if (!files || files.length === 0) return "na";

  const filesDiana = INDICADORS.map((ind) => pickIndicador(files, ind)).filter(Boolean); // solo considera los indicadores del popup

  if (!filesDiana.length) return "na";
  if (filesDiana.some((r) => estatDeFila(r) === "warn")) return "warn";
  return "ok";
}

function pointInRing(point, ring) { // Punto dentro del polígono
  const x = point[0],
    y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lngLat, geometry) {
  if (!geometry) return false;

  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates;
    if (!rings?.length) return false;
    if (!pointInRing(lngLat, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (pointInRing(lngLat, rings[k])) return false; // agujeros
    }
    return true;
  }

  if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      const rings = poly;
      if (!rings?.length) continue;
      if (!pointInRing(lngLat, rings[0])) continue;

      let inHole = false;
      for (let k = 1; k < rings.length; k++) {
        if (pointInRing(lngLat, rings[k])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    return false;
  }

  return false;
}

function boundsArea(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return Math.abs((ne.lat - sw.lat) * (ne.lng - sw.lng));
}

function buildSectorsLayer() {
  if (!geoSectors || !geoSectors.features) {
    throw new Error("GeoJSON de sectors invàlid o buit");
  }

  if (capaSectors) {
    map.removeLayer(capaSectors);
    capaSectors = null;
  }

  sectorsIndex = [];

  capaSectors = L.geoJSON(geoSectors, {
    style: () => styleHidden(),
    onEachFeature: (feature, layer) => {
      const props = feature?.properties || {};
      const sectorRaw = sectorFromProps(props) || props.name || props.NOM || "";
      const sectorKey = normalizeText(sectorRaw);

      const bounds = layer.getBounds();
      const area = boundsArea(bounds);

      sectorsIndex.push({
        sectorRaw,
        sectorKey,
        feature,
        layer,
        bounds,
        area
      });
    }
  }).addTo(map);
}

function autoZoomToSector(entry, anchorLatLng) {
  if (!entry || !entry.bounds) return "none";

  const headerH = document.querySelector(".header")?.offsetHeight || 0;
  const pad = 12;
  const extraTop = 20;

  const center = entry.bounds.getCenter();

  const target = L.latLngBounds(entry.bounds);
  if (anchorLatLng) target.extend(anchorLatLng);

  const fitOpts = {
    paddingTopLeft: [pad, headerH + pad + extraTop],
    paddingBottomRight: [pad, pad],
    maxZoom: 16,
    animate: true,
    duration: 1.2,
    easeLinearity: 0.15
  };

  const needsFit = !map.getBounds().contains(target) || map.getZoom() < 14;

  map.panTo(center, { animate: true, duration: 0.75 });

  if (!needsFit) return "pan";

  map.once("moveend", () => {
    map.fitBounds(target, fitOpts);
  });

  return "panfit";
}

function selectEntry(entry, clickLatLng) {
  clearSelection();

  const files = resultsBySector.get(entry.sectorKey) || [];
  const estat = calcularSemaforSector(files);
 
  const sectorCenter = entry.bounds ? entry.bounds.getCenter() : null;
  if (!sectorCenter) return;

  const popupLatLng = sectorCenter;

  const openPopup = () => {
    popupActiu = L.popup({
      closeButton: true,
      autoPan: false,
      maxWidth: 360
    })
      .setLatLng(popupLatLng)
      .setContent(buildPopupHTML(entry.sectorRaw, estat, files))
      .openOn(map);
  };

  const moved = autoZoomToSector(entry, popupLatLng);

  if (moved === "none") {
    openPopup();
    return;
  }

  if (moved === "pan") {
    map.once("moveend", openPopup);
    return;
  }

  map.once("moveend", () => {
    map.once("moveend", openPopup);
  });
}

function showUserError(message) { // Errores UI estilo
  const el = document.createElement("div");
  el.setAttribute("role", "alert");
  el.style.position = "fixed";
  el.style.left = "16px";
  el.style.right = "16px";
  el.style.bottom = "16px";
  el.style.zIndex = "9999";
  el.style.padding = "12px 14px";
  el.style.borderRadius = "12px";
  el.style.background = "rgba(20, 30, 40, 0.92)";
  el.style.color = "white";
  el.style.fontSize = "13px";
  el.style.lineHeight = "1.35";
  el.style.boxShadow = "0 10px 30px rgba(0,0,0,.25)";
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-start">
      <div style="font-weight:800">Avís</div>
      <div style="flex:1">${message}</div>
      <button id="closeErr" style="border:0;background:transparent;color:white;font-size:18px;line-height:1;cursor:pointer">×</button>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector("#closeErr")?.addEventListener("click", () => el.remove());
}

if (typeof L === "undefined") { // Arranque de Leaflet
  showUserError("No s’ha pogut carregar el mapa. Recarrega la pàgina o contacta amb Nostraigua.");
  throw new Error("Leaflet no carregat (L undefined)");
}

const mapEl = document.getElementById("map");
if (!mapEl) {
  showUserError("No s’ha pogut iniciar el mapa. Falta el contenidor <div id='map'>.");
  throw new Error("div#map no existeix");
}
if (mapEl.clientHeight < 50) {
  console.warn?.("⚠️ El #map té una alçada molt petita. Revisa el CSS height.");
}

const map = L.map("map", { zoomControl: false }).setView(CENTER, START_ZOOM); // Carga el mapa (sin zoom por defecto)

map.attributionControl.setPrefix(false);

L.control.zoom({ position: "topleft" }).addTo(map); // Botones + / - arriba a la izquierda

const ResetViewControl = L.Control.extend({ // reset vista inicial
  options: { position: "topleft" },

  onAdd: function () {
    const container = L.DomUtil.create("div", "leaflet-bar aquacheck-reset");
    const a = L.DomUtil.create("a", "", container);

    a.href = "#";
    a.title = "Restablecer vista";
    a.setAttribute("aria-label", "Restablecer vista");
    a.innerHTML = "↺";
    
    L.DomEvent.disableClickPropagation(container); // Evitar que el click en el botón interfiera con el mapa

    L.DomEvent.on(a, "click", (e) => {
      L.DomEvent.preventDefault(e);
      clearSelection();
      map.setView(CENTER, START_ZOOM, { animate: true });
    });

    return container;
  },
});

map.addControl(new ResetViewControl()); // botón reset vista en el mapa

const DROP_ICON_URL = "./assets/gota.png";

const waterDivIcon = L.divIcon({
  className: "drop-wrap",
  html: `<img class="drop-img" src="${DROP_ICON_URL}" alt="">`,
  iconSize: [28, 34],
  iconAnchor: [14, 34]
});

let clickMarker = null;

function showClickDrop(latlng) {
  if (clickMarker) {
    map.removeLayer(clickMarker);
    clickMarker = null;
  }

  clickMarker = L.marker(latlng, {
    icon: waterDivIcon,
    interactive: false,
    keyboard: false
  }).addTo(map);

  requestAnimationFrame(() => {
    const el = clickMarker && clickMarker.getElement();
    if (el) el.classList.add("drop-anim");
  });

  setTimeout(() => {
    if (clickMarker) {
      map.removeLayer(clickMarker);
      clickMarker = null;
    }
  }, 1000);
}

// Base OSM + fallback (para redes que bloqueen OpenStreetMap)
const attributionText = // Mención obligatoria a OpenStreetMap, por licencia
  'NOSTRAIGUA · © OpenStreetMap contributors';

const osmStandard = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    noWrap: true,
    attribution: attributionText,
  }
);

const osmFrance = L.tileLayer(
  "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    noWrap: true,
    attribution: attributionText,
  }
);

let activeBase = osmStandard.addTo(map);
let switched = false;
osmStandard.on("tileerror", () => {
  if (switched) return;
  switched = true;
  map.removeLayer(activeBase);
  activeBase = osmFrance.addTo(map);
});

// Datos de sectores/zonas
let geoSectors = null;
let capaSectors = null;
let sectorsIndex = []; 
let resultsBySector = new Map();

let selected = null;
let popupActiu = null;

function styleHidden() {
  return {
    color: "#000",
    weight: 2.5,
    opacity: 0,
    fillOpacity: 0,
    lineJoin: "round",
    lineCap: "round",
  };
}

function styleActive(estat) {
  const c = colorSemafor(estat);
  return {
    color: c,
    weight: 2.6,
    opacity: 0.85,
    fillColor: c,
    fillOpacity: 0.14,
    lineJoin: "round",
    lineCap: "round",
  };
}

function clearSelection() {
  if (selected) {
    selected.entry.layer.setStyle(styleHidden());
    selected = null;
  }
  if (popupActiu) {
    map.closePopup(popupActiu);
    popupActiu = null;
  }
}

function pickIndicador(files, indicador) {
  const keyNorm = normalizeText(indicador.key);
  return files.find(r => normalizeText(r.parametre) === keyNorm) || null;
}

function buildPopupHTML(sectorNom, estat, files) {
  const c = colorSemafor(estat);
  const label = labelSemafor(estat);

  const rows = INDICADORS.map(ind => {
    const r = pickIndicador(files, ind);

    if (!r) {
      return `
        <div class="row">
          <span class="label">${ind.key}</span>
          <span class="value muted">—</span>
          <span class="date muted">—</span>
        </div>`;
    }

    const unit = r.unitat ? ` ${r.unitat}` : "";
    const dataParam = r.data_mostra ? formatData(r.data_mostra) : "—";

    const p = normalizeText(r.parametre || "");
    const estatFila = (p === CLORURS_KEY || p === COND_KEY) ? "ok" : estatDeFila(r);

    return `
      <div class="row popup-row ${estatFila}">
        <span class="label">${ind.key}</span>
        <span class="value">${r.valor}${unit}</span>
        <span class="date">${dataParam}</span>
      </div>`;
  }).join("");
  
  // Configuració html del popup
  return `
  <div class="popup">
    <div class="popup-header">
      <div class="dot" style="background:${c}"></div>
      <div class="sector">${sectorNom || "Sector"}</div>
    </div>
    
    <div class="popup-status" style="border-left:4px solid ${c}">
      <div class="status-label" style="color:${c}">${label}</div>
    </div>
    
    <div class="popup-body">
      ${rows}
    </div>

    <div class="popup-footer">
      Dades informatives. Per a obtenir més informació, consulta la plataforma SINAC.
    </div>
  </div>`;
}

function selectEntry(entry, clickLatLng) {
  clearSelection();

  const files = resultsBySector.get(entry.sectorKey) || [];
  const estat = calcularSemaforSector(files);

  entry.layer.setStyle(styleActive(estat));
  entry.layer.bringToFront();
  selected = { entry, estat };

  const sectorCenter = entry.bounds ? entry.bounds.getCenter() : null;
  if (!sectorCenter) return;

  const far = map.getZoom() <= 13;
  const popupLatLng = (far || !clickLatLng) ? sectorCenter : clickLatLng;

  const openPopup = () => {

  clearClickDrop(); // ← elimina la gota justo antes de abrir el popup

    popupActiu = L.popup({
     closeButton: true,
      autoPan: false,
      maxWidth: 360
    })
    .setLatLng(popupLatLng)
    .setContent(buildPopupHTML(entry.sectorRaw, estat, files))
    .openOn(map);
  };

  const moved = autoZoomToSector(entry, popupLatLng);

  if (moved === "none") {
    openPopup();
    return;
  }

  if (moved === "fit" || moved === "pan") {
    map.once("moveend", openPopup);
    return;
  }

  map.once("moveend", () => {
    map.once("moveend", openPopup);
  });
}

map.on("click", (e) => {
  
  showClickDrop(e.latlng);
  
  const lngLat = [e.latlng.lng, e.latlng.lat];

  const candidates = sectorsIndex.filter((s) => s.bounds.contains(e.latlng));
  const hits = candidates.filter((s) => pointInGeometry(lngLat, s.feature.geometry));

  if (!hits.length) {
    clearSelection();
    return;
  }

  hits.sort((a, b) => a.area - b.area); // si hay solape, se fuerza a seleccionar el polígono más pequeño
  selectEntry(hits[0], e.latlng);
});

// ===== Índice del CSV =====
function buildResultsIndex(rows) {
  resultsBySector = new Map();

  for (const r of rows) {
    let sector = r.sector || r.SECTOR || "";
    sector = sector.replace(/^\uFEFF/, "").replace(/"/g, "").trim();

    const key = normalizeText(sector);
    if (!key) continue;

    const row = {
      sector,
      data_mostra: r.data_mostra || r["Data Mostra"] || r.data || r.Data || "",
      parametre: r.parametre || r.Parametre || r.PARAMETRE || "",
      valor: r.valor || r.Valor || "",
      unitat: r.unitat || r.Unitat || "",
      limit_min: r.limit_min || r.Minim || r["Minim"] || "",
      limit_max: r.limit_max || r.Maxim || r["Maxim"] || "",
    };

    if (!resultsBySector.has(key)) resultsBySector.set(key, []);
    resultsBySector.get(key).push(row);
  }
  
  for (const arr of resultsBySector.values()) { // ordenamos por fecha desc
    arr.sort((a, b) => new Date(b.data_mostra) - new Date(a.data_mostra));
  }
}

// INIT resultados
(async function init() {
  try {
    geoSectors = await fetchJSON(DATA_SECTORS);

    try { // Resultats CSV: si falla, continuem amb mapa i "SENSE DADES"
      const csv = await fetchText(DATA_RESULTS);
      const rows = parseCSV(csv);
      buildResultsIndex(rows);

      const updatedAt = document.getElementById("updatedAt");
      if (updatedAt && rows.length) {
        const dates = rows
          .map((r) => new Date(r.data_mostra || r.data || r.Data || ""))
          .filter((d) => !isNaN(d.getTime()))
          .map((d) => d.getTime());

        if (dates.length) {
          const maxDate = new Date(Math.max(...dates));
          updatedAt.textContent =
            "Última actualització: " + maxDate.toLocaleDateString("ca-ES");
        }
      }
    } catch (err) {
      console.warn("No se han podido cargar los resultados.", err);
      resultsBySector = new Map();
    }

    buildSectorsLayer();
  } catch (err) {
    console.error("INIT: no se han podido cargar los datos del mapa.", err);
    showUserError(
      "No se han podido cargar los datos del mapa. (" +
        (err?.message || String(err)) +
        ")"
    );
  }
})();