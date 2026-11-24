"use strict";

const NIVELES = {
  roja: { orden: 3, nombre: "Alerta Roja", css: "var(--roja)" },
  amarilla: { orden: 2, nombre: "Alerta Amarilla", css: "var(--amarilla)" },
  verde: { orden: 1, nombre: "Alerta Temprana Preventiva", css: "var(--verde)" },
};
const ESTADOS = { monitoreo: "En monitoreo", declarada: "Declarada", modificada: "Modificada", vigente: "Vigente" };
const ROMANOS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
const TRAMOS = [
  { id: 1, desde: 1, hasta: 3, color: "#8fb8ff" },
  { id: 2, desde: 4, hasta: 5, color: "#5b7cfa" },
  { id: 3, desde: 6, hasta: 7, color: "#7c3aed" },
  { id: 4, desde: 8, hasta: 12, color: "#c026d3" },
];
const ZONA_HORARIA = "America/Santiago";
// Debe coincidir con version.json y con el ?v= de index.html.
const VERSION = "2.0.0";
const RECIENTE_MIN = 60;
const CADA_MS = 60000;
const MIN_ATRASADO = 30;
const MIN_CAIDO = 90;
const DIAS_ANTIGUA = 30;
const CHILE = [[-76.2, -56.1], [-66.2, -17.3]];
const BASE = location.origin + location.pathname.replace(/[^/]*$/, "");

const estado = {
  datos: null,
  comunas: new Map(),
  comunaSel: null,
  alertaSel: null,
  eventoSel: null,
  verIntensidad: true,
  verAntiguas: true,
  satelite: false,
  pro: false,
  frescura: "caido",
  fallosCarga: 0,
  marcas: [],
};
const $ = (id) => document.getElementById(id);
const memoria = {
  leer(k) { try { return localStorage.getItem(k); } catch { return null; } },
  guardar(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

function normalizar(t) {
  return (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function nodo(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === "css") Object.entries(v).forEach(([p, c]) => n.style.setProperty(p, c));
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k in n && k !== "list") n[k] = v;
    else n.setAttribute(k, v);
  });
  hijos.flat().forEach((h) => h != null && h !== false && n.append(h));
  return n;
}
function vinculoSeguro(url) {
  try {
    const u = new URL(url);
    return ["senapred.cl", "www.sismologia.cl"].includes(u.hostname) && u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}

/* Fechas: siempre en hora de Chile */
function diaChile(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA, dateStyle: "short" }).format(d);
}
function hora(d) {
  return new Intl.DateTimeFormat("es-CL", { timeZone: ZONA_HORARIA, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
function fechaCorta(iso) {
  const d = new Date(iso);
  const hoy = new Date();
  const ayer = new Date(hoy.getTime() - 864e5);
  if (diaChile(d) === diaChile(hoy)) return `hoy ${hora(d)}`;
  if (diaChile(d) === diaChile(ayer)) return `ayer ${hora(d)}`;
  const dia = new Intl.DateTimeFormat("es-CL", { timeZone: ZONA_HORARIA, day: "numeric", month: "short" }).format(d);
  return `${dia} ${hora(d)}`;
}
function hace(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}
const diasSinNovedad = (a) => Math.floor((Date.now() - new Date(a.actualizada)) / 864e5);

/* Colores del mapa segun tema */
function color(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}
const opacidadRelleno = () => (estado.satelite ? 0.42 : estado.pro ? 0.5 : 0.62);
const nivelDe = ["coalesce", ["feature-state", "nivel"], 0];
const ANIMAR = !matchMedia("(prefers-reduced-motion: reduce)").matches;

const map = new maplibregl.Map({
  container: "mapa",
  attributionControl: false,
  bounds: CHILE,
  fitBoundsOptions: { padding: margenes() },
  minZoom: 2.2,
  maxZoom: 16.5,
  dragRotate: false,
  pitchWithRotate: false,
  renderWorldCopies: false,
  style: {
    version: 8,
    glyphs: `${BASE}vendor/glyphs/{fontstack}/{range}.pbf`,
    sources: {
      satelite: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 18,
        attribution: "Imágenes © Esri, Maxar, Earthstar Geographics",
      },
      lugares: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 18,
      },
    },
    layers: [
      { id: "fondo", type: "background", paint: { "background-color": color("--fondo") } },
      { id: "satelite", type: "raster", source: "satelite", layout: { visibility: "none" } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: [
    'Límites: <a href="https://www.bcn.cl/siit/mapas_vectoriales" target="_blank" rel="noopener">BCN</a>',
    'Epicentros: <a href="https://www.sismologia.cl/" target="_blank" rel="noopener">Centro Sismológico Nacional de la Universidad de Chile</a>',
  ],
}), "bottom-right");
map.touchZoomRotate.disableRotation();

function margenes() {
  if (innerWidth <= 760) return { top: 60, right: 20, left: 20, bottom: innerHeight * 0.48 };
  return { top: 24, right: 280, left: 396, bottom: 24 };
}

function tramaIntensidad(col) {
  const t = 16;
  const c = document.createElement("canvas");
  c.width = c.height = t;
  const x = c.getContext("2d");
  x.strokeStyle = col;
  x.lineWidth = 2.6;
  for (let i = -t; i <= t; i += 8) {
    x.beginPath(); x.moveTo(i, t); x.lineTo(i + t, 0); x.stroke();
  }
  return { width: t, height: t, data: x.getImageData(0, 0, t, t).data };
}

function prepararCapas(comunas, regiones) {
  const etiquetas = { type: "FeatureCollection", features: [] };
  comunas.features.forEach((f) => {
    const p = f.properties;
    if (!p.reg) return;
    const info = { ...p, caja: cajaDe(f.geometry) };
    info.centro = centroDe(f.geometry);
    estado.comunas.set(p.cut, info);
    etiquetas.features.push({ type: "Feature", properties: { nombre: p.nombre }, geometry: { type: "Point", coordinates: info.centro } });
  });

  map.addSource("comunas", { type: "geojson", data: comunas, promoteId: "cut" });
  map.addSource("regiones", { type: "geojson", data: regiones });
  map.addSource("etiquetas", { type: "geojson", data: etiquetas });

  map.addLayer({
    id: "comunas-relleno",
    type: "fill",
    source: "comunas",
    paint: {
      "fill-color": ["match", ["coalesce", ["feature-state", "nivel"], 0],
        3, color("--roja"), 2, color("--amarilla"), 1, color("--verde"), "rgba(0,0,0,0)"],
      "fill-opacity": opacidadRelleno(),
    },
  });
  TRAMOS.forEach((t) => {
    map.addImage(`trama-${t.id}`, tramaIntensidad(t.color), { pixelRatio: 2 });
    map.addLayer({
      id: `intensidad-${t.id}`,
      type: "fill",
      source: "comunas",
      filter: ["in", ["get", "cut"], ["literal", []]],
      paint: { "fill-pattern": `trama-${t.id}` },
    });
  });
  map.addLayer({
    id: "comunas-linea",
    type: "line",
    source: "comunas",
    paint: {
      "line-color": color("--tenue"),
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0.28, 6, 0.42, 9, 0.7],
      "line-width": ["interpolate", ["linear"], ["zoom"], 3.5, 0.35, 8, 0.8],
    },
  });
  // Halos del modo pro: solo se muestran en ese modo.
  map.addLayer({
    id: "regiones-brillo",
    type: "line",
    source: "regiones",
    filter: [">", ["get", "reg"], 0],
    layout: { visibility: "none" },
    paint: { "line-color": "#38d6f5", "line-width": 6, "line-blur": 5, "line-opacity": 0.32 },
  });
  map.addLayer({
    id: "alertas-brillo",
    type: "line",
    source: "comunas",
    layout: { visibility: "none" },
    paint: {
      "line-color": ["match", nivelDe, 3, color("--roja"), 2, color("--amarilla"), 1, color("--verde"), "rgba(0,0,0,0)"],
      "line-width": 5,
      "line-blur": 4,
      "line-opacity": ["match", nivelDe, 3, 0.9, 2, 0.7, 1, 0.55, 0],
    },
  });
  map.addLayer({
    id: "regiones-linea",
    type: "line",
    source: "regiones",
    filter: [">", ["get", "reg"], 0],
    paint: {
      "line-color": color("--texto"),
      "line-opacity": 0.62,
      "line-width": ["interpolate", ["linear"], ["zoom"], 3.5, 0.6, 8, 1.4],
    },
  });
  map.addLayer({
    id: "cobertura-linea",
    type: "line",
    source: "comunas",
    filter: ["in", ["get", "cut"], ["literal", []]],
    paint: { "line-color": color("--texto"), "line-width": 1.1, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "seleccion-linea",
    type: "line",
    source: "comunas",
    filter: ["==", ["get", "cut"], -1],
    paint: { "line-color": color("--texto"), "line-width": 2.4 },
  });
  map.addLayer({ id: "lugares", type: "raster", source: "lugares", layout: { visibility: "none" } });
  map.addLayer({
    id: "etiquetas",
    type: "symbol",
    source: "etiquetas",
    minzoom: 6.6,
    layout: {
      "text-field": ["get", "nombre"],
      "text-font": ["Open Sans Semibold"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 6.6, 10, 10, 13],
      "text-max-width": 8,
      "text-padding": 4,
    },
    paint: { "text-color": color("--texto"), "text-halo-color": color("--fondo"), "text-halo-width": 1.4 },
  });
}

function cajaDe(g) {
  const c = [180, 90, -180, -90];
  const recorrer = (a) => {
    if (typeof a[0] === "number") {
      c[0] = Math.min(c[0], a[0]); c[1] = Math.min(c[1], a[1]);
      c[2] = Math.max(c[2], a[0]); c[3] = Math.max(c[3], a[1]);
    } else a.forEach(recorrer);
  };
  recorrer(g.coordinates);
  return c;
}
function poligonos(g) {
  return g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
}
function areaAnillo(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function centroDe(g) {
  const anillo = poligonos(g).map((p) => p[0]).sort((x, y) => Math.abs(areaAnillo(y)) - Math.abs(areaAnillo(x)))[0];
  const a = areaAnillo(anillo) || 1e-9;
  let x = 0, y = 0;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const f = anillo[j][0] * anillo[i][1] - anillo[i][0] * anillo[j][1];
    x += (anillo[j][0] + anillo[i][0]) * f;
    y += (anillo[j][1] + anillo[i][1]) * f;
  }
  return [x / (6 * a), y / (6 * a)];
}

/* Datos */
const alertasVisibles = () => (estado.datos?.alertas || []).filter((a) => estado.verAntiguas || diasSinNovedad(a) <= DIAS_ANTIGUA);
const alertasDe = (cut) => alertasVisibles().filter((a) => a.comunas.includes(cut));
const eventosDe = (cut) => (estado.datos?.eventos || []).filter((e) => e.comunas.includes(cut) || e.sismo?.intensidades?.[cut]);
const buscarAlerta = (id) => (estado.datos?.alertas || []).find((a) => a.id === id);
const buscarEvento = (id) => (estado.datos?.eventos || []).find((e) => e.id === id);
const peor = (lista) => lista.reduce((m, a) => (!m || NIVELES[a.nivel].orden > NIVELES[m.nivel].orden ? a : m), null);

async function cargarDatos() {
  try {
    const r = await fetch(`data/alertas.json?t=${Math.floor(Date.now() / CADA_MS)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    estado.datos = await r.json();
    estado.fallosCarga = 0;
  } catch {
    estado.fallosCarga += 1;
  }
  actualizarPuente();
  pintar();
  dibujarPanel();
}

function evaluarFrescura() {
  const lectura = estado.datos?.meta?.ultima_lectura_ok;
  if (!lectura) return "caido";
  const min = (Date.now() - new Date(lectura)) / 6e4;
  if (min > MIN_CAIDO) return "caido";
  if (min > MIN_ATRASADO || estado.fallosCarga >= 3) return "atrasado";
  return "ok";
}

function actualizarPuente() {
  const meta = estado.datos?.meta;
  estado.frescura = evaluarFrescura();
  $("puente-luz").className = `luz ${estado.frescura}`;
  const lectura = meta?.ultima_lectura_ok;
  $("puente-texto").textContent = lectura
    ? `Puente SENAPRED: actualizado ${hace(lectura)} (${hora(new Date(lectura))})`
    : "Puente SENAPRED: sin datos";

  const filas = [
    ["Última lectura correcta", lectura && fechaCorta(lectura)],
    ["Último intento", meta?.ultimo_intento && fechaCorta(meta.ultimo_intento)],
    ["Último cambio detectado", meta?.ultimo_cambio && fechaCorta(meta.ultimo_cambio)],
    ["Última publicación de SENAPRED", meta?.ultima_publicacion_senapred && fechaCorta(meta.ultima_publicacion_senapred)],
  ];
  $("puente-detalle").replaceChildren(
    ...filas.flatMap(([k, v]) => [nodo("dt", { textContent: k }), nodo("dd", { textContent: v || "—" })]),
    ...(meta?.estado === "error" ? [nodo("dd", { className: "error", textContent: "El último intento de lectura falló. Se muestran los últimos datos correctos." })] : []),
  );

  const aviso = $("aviso-datos");
  if (estado.frescura === "ok") {
    aviso.hidden = true;
    return;
  }
  aviso.hidden = false;
  aviso.className = `aviso-datos ${estado.frescura}`;
  const desde = lectura ? ` desde ${fechaCorta(lectura)}` : "";
  aviso.replaceChildren(
    `Sin datos nuevos de SENAPRED${desde}. Pueden faltar alertas recientes: revisa `,
    nodo("a", { href: "https://senapred.cl/alertas/", target: "_blank", rel: "noopener", textContent: "senapred.cl" }),
    ".",
  );
}

function pintar() {
  if (!map.getSource("comunas") || !estado.datos) return;
  const niveles = new Map();
  const seleccion = buscarAlerta(estado.alertaSel);
  (seleccion ? [seleccion] : alertasVisibles()).forEach((a) => {
    const n = NIVELES[a.nivel].orden;
    a.comunas.forEach((c) => niveles.set(c, Math.max(niveles.get(c) || 0, n)));
  });
  map.removeFeatureState({ source: "comunas" });
  niveles.forEach((nivel, id) => map.setFeatureState({ source: "comunas", id }, { nivel }));

  const inten = new Map();
  const eventos = estado.eventoSel ? [buscarEvento(estado.eventoSel)].filter(Boolean) : estado.datos.eventos;
  if (estado.verIntensidad && !seleccion) {
    eventos.forEach((e) => Object.entries(e.sismo?.intensidades || {}).forEach(([c, v]) => {
      inten.set(+c, Math.max(inten.get(+c) || 0, ROMANOS[v] || 0));
    }));
  }
  TRAMOS.forEach((t) => {
    const cuts = [...inten].filter(([, v]) => v >= t.desde && v <= t.hasta).map(([c]) => c);
    map.setFilter(`intensidad-${t.id}`, ["in", ["get", "cut"], ["literal", cuts]]);
  });

  const cubiertas = seleccion?.comunas || (buscarEvento(estado.eventoSel)?.comunas ?? []);
  map.setFilter("cobertura-linea", ["in", ["get", "cut"], ["literal", cubiertas]]);
  map.setFilter("seleccion-linea", ["==", ["get", "cut"], estado.comunaSel ?? -1]);
  dibujarMarcas(seleccion);
  actualizarPro();
}

function dibujarMarcas(seleccion) {
  estado.marcas.forEach((m) => m.remove());
  estado.marcas = [];
  (seleccion ? [seleccion] : alertasVisibles()).forEach((a) => a.puntos.forEach((p) => {
    const titulo = `${p.nombre}: ${NIVELES[a.nivel].nombre}`;
    const el = nodo("button", {
      type: "button", className: "pin volcan", title: titulo, ariaLabel: titulo,
      css: { "--color": NIVELES[a.nivel].css }, onclick: (ev) => { ev.stopPropagation(); elegirAlerta(a.id); },
    });
    estado.marcas.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
  }));
}

/* Seleccion */
function encuadrar(cuts, puntos = []) {
  const caja = [180, 90, -180, -90];
  cuts.forEach((c) => {
    const k = estado.comunas.get(c)?.caja;
    if (!k) return;
    caja[0] = Math.min(caja[0], k[0]); caja[1] = Math.min(caja[1], k[1]);
    caja[2] = Math.max(caja[2], k[2]); caja[3] = Math.max(caja[3], k[3]);
  });
  puntos.forEach((p) => {
    caja[0] = Math.min(caja[0], p.lon); caja[1] = Math.min(caja[1], p.lat);
    caja[2] = Math.max(caja[2], p.lon); caja[3] = Math.max(caja[3], p.lat);
  });
  if (caja[0] > caja[2]) return;
  const m = margenes();
  map.fitBounds([[caja[0], caja[1]], [caja[2], caja[3]]], {
    padding: { top: m.top + 30, bottom: m.bottom + 30, left: m.left + 30, right: m.right + 30 },
    maxZoom: 12, duration: 650,
  });
}
function elegirComuna(cut, { mover = true } = {}) {
  estado.comunaSel = cut;
  estado.alertaSel = null;
  estado.eventoSel = null;
  pintar();
  dibujarPanel();
  $("contenido").scrollTop = 0;
  if (mover) encuadrar([cut]);
}
function elegirAlerta(id) {
  const repetida = estado.alertaSel === id;
  estado.alertaSel = repetida ? null : id;
  estado.eventoSel = null;
  pintar();
  dibujarPanel();
  mostrarTarjetaAbierta();
  const a = buscarAlerta(id);
  if (!repetida && a) encuadrar(a.comunas, a.puntos);
}
function elegirEvento(id) {
  const repetido = estado.eventoSel === id;
  estado.eventoSel = repetido ? null : id;
  estado.alertaSel = null;
  pintar();
  dibujarPanel();
  mostrarTarjetaAbierta();
  const e = buscarEvento(id);
  if (repetido || !e) return;
  const inten = Object.keys(e.sismo?.intensidades || {}).map(Number);
  encuadrar([...e.comunas, ...inten], e.punto ? [e.punto] : []);
}
function mostrarTarjetaAbierta() {
  document.querySelector(".tarjeta.abierta")?.scrollIntoView({ block: "nearest" });
}
function limpiar() {
  estado.comunaSel = null;
  estado.alertaSel = null;
  estado.eventoSel = null;
  pintar();
  dibujarPanel();
  map.fitBounds(CHILE, { padding: margenes(), duration: 650 });
}

/* Panel */
function tarjetaAlerta(a) {
  const n = NIVELES[a.nivel];
  const abierta = estado.alertaSel === a.id;
  const dias = diasSinNovedad(a);
  const url = vinculoSeguro(a.url);
  const detalle = abierta && nodo("div", { className: "detalle" },
    a.inferida && nodo("span", { className: "etiqueta-nota", textContent: "No pudimos leer el territorio exacto. Se muestra toda la región: revisa el detalle oficial." }),
    a.parcial && nodo("span", { className: "etiqueta-nota", textContent: "Afecta solo a parte de esta zona. El mapa pinta el territorio completo." }),
    nodo("p", { textContent: a.cobertura }),
    a.puntos.length > 0 && nodo("p", { textContent: `Punto en el mapa: ${a.puntos.map((p) => p.nombre).join(", ")}` }),
    a.sectores.length > 0 && nodo("p", { textContent: `Sectores mencionados: ${a.sectores.join(", ")}` }),
    nodo("p", { className: "meta", textContent: `${ESTADOS[a.estado]} · Última actualización ${fechaCorta(a.actualizada)}` }),
    url && nodo("a", { className: "vinculo", href: url, target: "_blank", rel: "noopener", textContent: "Ver publicación oficial" }),
    nodo("div", { className: "texto" }, a.texto.map((t) => nodo("p", { textContent: t }))),
  );
  return nodo("article", { className: abierta ? "tarjeta abierta" : "tarjeta", css: { "--color": n.css } },
    nodo("button", { type: "button", ariaExpanded: String(abierta), onclick: () => elegirAlerta(a.id) },
      nodo("span", { className: "punto" }),
      nodo("span", { className: "cabeza", textContent: n.nombre }),
      nodo("span", { className: "linea", textContent: `${a.amenaza} · ${a.cobertura}` }),
      nodo("span", { className: "linea", textContent: dias > 7 ? `Sin novedades hace ${dias} días` : `${ESTADOS[a.estado]} · ${fechaCorta(a.actualizada)}` }),
    ),
    detalle || null,
  );
}

function resumenSismo(e, cut) {
  const s = e.sismo;
  const partes = [];
  if (s.magnitud) partes.push(`Magnitud ${s.magnitud}`);
  const local = cut != null ? s.intensidades[cut] : null;
  if (local) partes.push(`Intensidad ${local} aquí`);
  else if (s.intensidad_max) partes.push(`Intensidad máxima ${s.intensidad_max}`);
  return partes.join(" · ");
}
function tarjetaEvento(e, cut) {
  const abierta = estado.eventoSel === e.id;
  const url = vinculoSeguro(e.url);
  const s = e.sismo;
  const epi = s?.epicentro;
  const lista = s ? Object.entries(s.intensidades)
    .sort((a, b) => ROMANOS[b[1]] - ROMANOS[a[1]])
    .map(([c, v]) => `${estado.comunas.get(+c)?.nombre || c}: ${v}`) : [];
  const detalle = abierta && nodo("div", { className: "detalle" },
    s?.referencia && nodo("p", { textContent: `Localizado a ${s.referencia}` }),
    epi && nodo("p", { className: "meta", textContent: `${epi.aproximado ? "Epicentro aproximado" : "Epicentro"}: ${epi.fuente}${epi.prof_km ? ` · ${epi.prof_km} km de profundidad` : ""}` }),
    lista.length > 0 && nodo("p", { textContent: `Intensidad Mercalli: ${lista.join(", ")}` }),
    s?.sin_ubicar?.length > 0 && nodo("p", { className: "meta", textContent: `También sentido en: ${s.sin_ubicar.join(", ")}` }),
    url && nodo("a", { className: "vinculo", href: url, target: "_blank", rel: "noopener", textContent: "Ver publicación oficial" }),
    !s && nodo("div", { className: "texto" }, e.texto.map((t) => nodo("p", { textContent: t }))),
  );
  return nodo("article", { className: abierta ? "tarjeta abierta" : "tarjeta", css: { "--color": "var(--azul)" } },
    nodo("button", { type: "button", ariaExpanded: String(abierta), onclick: () => elegirEvento(e.id) },
      nodo("span", { className: "punto" }),
      nodo("span", { className: "cabeza", textContent: e.titulo }),
      nodo("span", { className: "linea", textContent: [s && resumenSismo(e, cut), fechaCorta(e.fecha)].filter(Boolean).join(" · ") }),
    ),
    detalle || null,
  );
}

function vistaNacional() {
  const alertas = alertasVisibles();
  const cuenta = (n) => alertas.filter((a) => a.nivel === n).length;
  const bloques = [
    nodo("div", { className: "resumen" }, ["roja", "amarilla", "verde"].map((n) => nodo("div", { className: "cifra", css: { "--color": NIVELES[n].css } },
      nodo("b", { textContent: String(cuenta(n)) }),
      nodo("span", { textContent: n === "verde" ? "Preventivas" : n === "roja" ? "Rojas" : "Amarillas" }),
    ))),
  ];
  bloques.push(nodo("h2", { className: "seccion", textContent: `Alertas vigentes (${alertas.length})` }));
  bloques.push(alertas.length ? alertas.map(tarjetaAlerta) : nodo("p", { className: "sin-datos", textContent: mensajeSinAlertas("en Chile") }));
  const eventos = estado.datos?.eventos || [];
  bloques.push(nodo("h2", { className: "seccion", textContent: `Eventos, últimas 48 h (${eventos.length})` }));
  bloques.push(eventos.length ? eventos.map((e) => tarjetaEvento(e)) : nodo("p", { className: "sin-datos", textContent: "Sin eventos en las últimas 48 horas." }));
  return bloques.flat();
}
function mensajeSinAlertas(lugar) {
  if (estado.frescura !== "ok") return `No podemos confirmar si hay alertas ${lugar}: los datos no están al día. Revisa senapred.cl.`;
  return `Sin alertas activas ${lugar}.`;
}
function vistaComuna(cut) {
  const c = estado.comunas.get(cut);
  const alertas = alertasDe(cut);
  const eventos = eventosDe(cut);
  const mayor = peor(alertas);
  const lectura = estado.datos?.meta?.ultima_lectura_ok;
  const sub = lectura ? `Según la lectura de las ${hora(new Date(lectura))}` : "";
  return [
    nodo("button", { className: "volver", type: "button", textContent: "← Todo Chile", onclick: limpiar }),
    nodo("h2", { className: "comuna-titulo", textContent: c.nombre }),
    nodo("p", { className: "comuna-sub", textContent: `Provincia de ${c.provincia} · ${c.region}` }),
    nodo("div", { className: "estado-comuna", css: mayor ? { "--color": NIVELES[mayor.nivel].css } : {} },
      nodo("span", {},
        mayor ? `${NIVELES[mayor.nivel].nombre}${alertas.length > 1 ? ` y ${alertas.length - 1} más` : ""}` : mensajeSinAlertas("en esta comuna"),
        nodo("small", { textContent: sub }),
      ),
    ),
    alertas.length > 0 && nodo("h3", { className: "seccion", textContent: `Alertas activas aquí (${alertas.length})` }),
    alertas.map(tarjetaAlerta),
    eventos.length > 0 && nodo("h3", { className: "seccion", textContent: `Eventos, últimas 48 h (${eventos.length})` }),
    eventos.map((e) => tarjetaEvento(e, cut)),
    alertas.length > 0 && nodo("p", { className: "sin-datos", textContent: "Toca una alerta para ver en el mapa todo el territorio que cubre." }),
  ].flat().filter(Boolean);
}
function dibujarPanel() {
  if (!estado.comunas.size) return;
  const cont = $("contenido");
  const scroll = cont.scrollTop;
  cont.replaceChildren(...(estado.comunaSel != null ? vistaComuna(estado.comunaSel) : vistaNacional()));
  cont.scrollTop = scroll;
  const n = (estado.datos?.alertas || []).filter((a) => diasSinNovedad(a) > DIAS_ANTIGUA).length;
  $("ver-antiguas-texto").textContent = `Incluir alertas sin novedades hace más de ${DIAS_ANTIGUA} días (${n})`;
}

/* Buscador */
function iniciarBuscador() {
  const entrada = $("buscar");
  const lista = $("sugerencias");
  const comunas = [...estado.comunas.values()]
    .map((c) => ({ ...c, clave: normalizar(c.nombre) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  let activos = [];
  let indice = 0;
  const cerrar = () => { lista.hidden = true; entrada.setAttribute("aria-expanded", "false"); };
  const elegir = (c) => { entrada.value = ""; cerrar(); entrada.blur(); elegirComuna(c.cut); };
  const dibujar = () => {
    lista.replaceChildren(...activos.map((c) => nodo("li", {
      role: "option", onmousedown: (e) => { e.preventDefault(); elegir(c); },
    }, c.nombre, nodo("small", { textContent: c.provincia }))));
    [...lista.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === indice)));
  };
  entrada.addEventListener("input", () => {
    const q = normalizar(entrada.value);
    activos = q ? comunas
      .filter((c) => c.clave.includes(q))
      .sort((a, b) => a.clave.indexOf(q) - b.clave.indexOf(q))
      .slice(0, 8) : [];
    indice = 0;
    lista.hidden = !activos.length;
    entrada.setAttribute("aria-expanded", String(!!activos.length));
    dibujar();
  });
  entrada.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && activos[indice]) { e.preventDefault(); elegir(activos[indice]); }
    else if (e.key === "Escape") cerrar();
    else if (e.key === "ArrowDown" && activos.length) { e.preventDefault(); indice = (indice + 1) % activos.length; dibujar(); }
    else if (e.key === "ArrowUp" && activos.length) { e.preventDefault(); indice = (indice - 1 + activos.length) % activos.length; dibujar(); }
  });
  entrada.addEventListener("blur", cerrar);
}

/* Controles */
function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  memoria.guardar("tema", tema);
  const claro = tema === "claro";
  const titulo = claro ? "Cambiar a modo oscuro" : "Cambiar a modo claro";
  $("tema").title = titulo;
  $("tema").setAttribute("aria-label", titulo);
  $("tema").innerHTML = claro
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" fill="none"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z"/></svg>';
  document.querySelector('meta[name="theme-color"]').content = color("--fondo");
  if (map.getLayer("comunas-linea")) colorearMapa();
}
function colorearMapa() {
  map.setPaintProperty("fondo", "background-color", color("--fondo"));
  // Sobre la imagen satelital el relleno se confunde con el terreno: el borde lleva el color de la alerta.
  // En el modo pro pasa lo mismo, para que las comunas en alerta brillen.
  const porNivel = (resto) => ["match", nivelDe, 3, color("--roja"), 2, color("--amarilla"), 1, color("--verde"), resto];
  map.setPaintProperty("comunas-linea", "line-color", estado.satelite ? porNivel("#ffffff") : estado.pro ? porNivel(color("--tenue")) : color("--tenue"));
  map.setPaintProperty("comunas-linea", "line-width", estado.satelite ? 1.6 : ["interpolate", ["linear"], ["zoom"], 3.5, 0.35, 8, 0.8]);
  map.setPaintProperty("regiones-linea", "line-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("cobertura-linea", "line-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("seleccion-linea", "line-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("etiquetas", "text-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("etiquetas", "text-halo-color", estado.satelite ? "#000000" : color("--fondo"));
  map.setPaintProperty("comunas-relleno", "fill-opacity", opacidadRelleno());
}
function aplicarBase(base) {
  if (!map.getLayer("comunas-linea")) return;
  const eraPro = estado.pro;
  estado.satelite = base === "satelite";
  estado.pro = base === "pro";
  ["mapa", "satelite", "pro"].forEach((b) => $(`base-${b}`).setAttribute("aria-pressed", String(b === base)));
  const ver = (id, si) => map.setLayoutProperty(id, "visibility", si ? "visible" : "none");
  ver("satelite", estado.satelite);
  ver("lugares", estado.satelite);
  ver("regiones-brillo", estado.pro);
  ver("alertas-brillo", estado.pro);
  document.documentElement.dataset.base = base;
  $("tema").disabled = estado.pro;
  document.querySelector('meta[name="theme-color"]').content = color("--fondo");
  colorearMapa();
  if (estado.pro !== eraPro) alternarPro();
}

/* Modo pro: sala de situacion animada. Solo cambia la presentacion, no los datos. */
const pro = { vuelta: 0, reloj: 0, balizas: [], clave: "" };

function alternarPro() {
  const capa = $("pro");
  const vuelta = ++pro.vuelta;
  clearInterval(pro.reloj);
  capa.hidden = !estado.pro;
  if (!estado.pro) {
    dibujarBalizas();
    cerrarHuevo();
    map.easeTo({ pitch: 0, duration: ANIMAR ? 900 : 0 });
    return;
  }
  capa.classList.remove("arranca");
  void capa.offsetWidth;
  capa.classList.add("arranca");
  actualizarPro();
  marcarReloj();
  pro.reloj = setInterval(marcarReloj, 1000);
  map.easeTo({ pitch: 38, duration: ANIMAR ? 2200 : 0 });
  if (!ANIMAR) return;
  const latir = (t) => {
    if (vuelta !== pro.vuelta) return;
    const onda = (ms, min, max) => min + (max - min) * (0.5 + 0.5 * Math.sin((t / ms) * 2 * Math.PI));
    map.setPaintProperty("comunas-relleno", "fill-opacity",
      ["match", nivelDe, 3, onda(1200, 0.28, 0.7), 2, onda(2000, 0.24, 0.5), 1, onda(3000, 0.2, 0.38), 0]);
    map.setPaintProperty("alertas-brillo", "line-opacity",
      ["match", nivelDe, 3, onda(1200, 0.45, 1), 2, onda(2000, 0.35, 0.8), 1, onda(3000, 0.3, 0.6), 0]);
    setTimeout(() => requestAnimationFrame(latir), 60);
  };
  requestAnimationFrame(latir);
}

function marcarReloj() {
  $("pro-reloj").textContent = `${new Intl.DateTimeFormat("es-CL", {
    timeZone: ZONA_HORARIA, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date())} CHILE`;
  pro.balizas.forEach((b) => { b.texto.textContent = `${b.r.tipo} · ${hace(b.r.fecha)}`; });
}

/* Emergencias de la ultima hora: luz titilante en el mapa y aviso en la barra */
function recientes() {
  if (!estado.datos) return [];
  const limite = Date.now() - RECIENTE_MIN * 6e4;
  const eventos = estado.datos.eventos
    .filter((e) => e.punto && new Date(e.fecha) >= limite)
    .map((e) => ({
      id: e.id, tipo: e.sismo ? "Sismo" : "Evento", fecha: e.fecha, lugar: e.sismo?.epicentro || e.punto,
      color: "var(--naranja)", abrir: () => elegirEvento(e.id),
    }));
  const alertas = alertasVisibles()
    .filter((a) => new Date(a.actualizada) >= limite)
    .map((a) => {
      const c = estado.comunas.get(a.comunas[0]);
      const lugar = a.puntos[0] || (c && { lon: c.centro[0], lat: c.centro[1] });
      return lugar && {
        id: a.id, tipo: NIVELES[a.nivel].nombre, fecha: a.actualizada, lugar,
        color: NIVELES[a.nivel].css, abrir: () => elegirAlerta(a.id),
      };
    })
    .filter(Boolean);
  return [...eventos, ...alertas].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

function dibujarBalizas() {
  const lista = estado.pro ? recientes() : [];
  const clave = lista.map((r) => r.id).join();
  const chip = $("pro-reciente");
  chip.hidden = !lista.length;
  $("pro").classList.toggle("con-reciente", lista.length > 0);
  if (lista.length) {
    chip.textContent = `${lista[0].tipo} ${hace(lista[0].fecha)}${lista.length > 1 ? ` +${lista.length - 1}` : ""}`;
  }
  if (clave === pro.clave) return;
  pro.clave = clave;
  pro.balizas.forEach((b) => b.marca.remove());
  pro.balizas = lista.map((r) => {
    const titulo = `${r.tipo} ${hace(r.fecha)}`;
    const texto = nodo("span", { className: "baliza-texto", textContent: `${r.tipo} · ${hace(r.fecha)}` });
    const el = nodo("button", {
      type: "button", className: "baliza", title: titulo, ariaLabel: titulo, css: { "--color": r.color },
      onclick: (ev) => { ev.stopPropagation(); r.abrir(); },
    }, nodo("span", { className: "baliza-luz" }), texto);
    return { r, texto, marca: new maplibregl.Marker({ element: el, anchor: "left", offset: [-9, 0] }).setLngLat([r.lugar.lon, r.lugar.lat]).addTo(map) };
  });
}

function actualizarPro() {
  if (!estado.pro || !estado.datos) return;
  dibujarBalizas();
  const alertas = [...alertasVisibles()].sort((a, b) =>
    NIVELES[b.nivel].orden - NIVELES[a.nivel].orden || new Date(b.actualizada) - new Date(a.actualizada));
  const p = peor(alertas);
  $("pro-nivel").textContent = p ? NIVELES[p.nivel].nombre.toUpperCase() : "SIN ALERTAS";
  $("pro-nivel").style.setProperty("--color", p ? NIVELES[p.nivel].css : "var(--tenue)");
  const sismos = estado.datos.eventos.filter((e) => e.sismo).length;
  const plural = (n, palabra) => `${n} ${palabra}${n === 1 ? "" : "S"}`;
  $("pro-cifras").textContent = `${plural(alertas.length, "ALERTA")} · ${plural(sismos, "SISMO")} 48 H`;
  const avisos = [
    ...alertas.map((a) => `${NIVELES[a.nivel].nombre.toUpperCase()} · ${a.titulo}`),
    ...estado.datos.eventos.map((e) => `${e.sismo ? "SISMO" : "EVENTO"} · ${e.titulo}`),
  ];
  const texto = `${(avisos.length ? avisos : ["Sin alertas vigentes publicadas por SENAPRED"]).join("   ◆   ")}   ◆   `;
  const pista = $("pro-pista");
  if (pista.dataset.texto === texto) return;
  pista.dataset.texto = texto;
  pista.replaceChildren(nodo("span", { textContent: texto }), nodo("span", { textContent: texto }));
  pista.style.setProperty("--duracion", `${Math.max(40, Math.round(texto.length * 0.18))}s`);
}

/* Secretos del modo Pro: se activan escribiendo el nombre en el teclado */
let finHuevo = 0;
function mostrarHuevo(clase, contenido, ms) {
  clearTimeout(finHuevo);
  const h = $("huevo");
  h.className = `huevo ${clase}`;
  h.replaceChildren(...contenido);
  h.hidden = false;
  finHuevo = setTimeout(cerrarHuevo, ms);
}
function cerrarHuevo() {
  clearTimeout(finHuevo);
  $("huevo").hidden = true;
  $("huevo").replaceChildren();
}
const lienzoCompleto = () => {
  const l = nodo("canvas", { className: "huevo-lienzo" });
  l.width = innerWidth;
  l.height = innerHeight;
  return l;
};

function lluviaMatrix() {
  const lienzo = lienzoCompleto();
  mostrarHuevo("matrix", [lienzo, nodo("p", { className: "huevo-frase", textContent: "Sigue al conejo blanco." })], 9000);
  if (!ANIMAR) return;
  const x = lienzo.getContext("2d");
  const tam = 16;
  const gotas = Array.from({ length: Math.ceil(lienzo.width / tam) }, () => Math.random() * -40);
  const signos = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789";
  let previo = 0;
  const caer = (t) => {
    if (!lienzo.isConnected) return;
    if (t - previo > 45) {
      previo = t;
      x.fillStyle = "rgba(0, 8, 2, .12)";
      x.fillRect(0, 0, lienzo.width, lienzo.height);
      x.font = `${tam}px monospace`;
      gotas.forEach((y, i) => {
        x.fillStyle = Math.random() > 0.96 ? "#d7ffd9" : "#22e06b";
        x.fillText(signos[Math.floor(Math.random() * signos.length)], i * tam, y * tam);
        gotas[i] = y * tam > lienzo.height && Math.random() > 0.975 ? 0 : y + 1;
      });
    }
    requestAnimationFrame(caer);
  };
  requestAnimationFrame(caer);
}

function logograma() {
  const lienzo = lienzoCompleto();
  mostrarHuevo("arrival", [lienzo, nodo("p", { className: "huevo-frase", textContent: "Un idioma sin principio ni fin." })], 8000);
  const x = lienzo.getContext("2d");
  const cx = lienzo.width / 2;
  const cy = lienzo.height / 2;
  const radio = Math.min(lienzo.width, lienzo.height) * 0.24;
  const manchas = Array.from({ length: 7 }, () => ({ a: Math.random() * 2 * Math.PI, largo: 0.12 + Math.random() * 0.4, grueso: 8 + Math.random() * 30 }));
  const semilla = Math.random() * 10;
  const inicio = performance.now();
  const trazar = (t) => {
    if (!lienzo.isConnected) return;
    const avance = ANIMAR ? Math.min(1, (t - inicio) / 2600) : 1;
    x.clearRect(0, 0, lienzo.width, lienzo.height);
    x.strokeStyle = "rgba(14, 14, 18, .9)";
    x.lineCap = "round";
    for (let k = 0; k < Math.floor(360 * avance); k++) {
      const ang = -Math.PI / 2 + (k / 360) * 2 * Math.PI;
      let grosor = 3;
      manchas.forEach((m) => {
        const d = Math.atan2(Math.sin(ang - m.a), Math.cos(ang - m.a));
        grosor += m.grueso * Math.exp(-((d / m.largo) ** 2));
      });
      x.beginPath();
      x.lineWidth = grosor;
      x.arc(cx, cy, radio + Math.sin(ang * 5 + semilla) * 5, ang, ang + 0.022);
      x.stroke();
    }
    if (avance < 1) requestAnimationFrame(trazar);
  };
  requestAnimationFrame(trazar);
}

function juegoGuerra() {
  const pantalla = nodo("pre", { className: "huevo-terminal" });
  mostrarHuevo("wargames", [pantalla], 11000);
  const texto = "CONECTANDO CON WOPR...\n\n¿QUIERES JUGAR UN JUEGO?\n\n> GUERRA TERMONUCLEAR GLOBAL\n\nSIMULANDO ESCENARIOS...\n\nLA ÚNICA JUGADA GANADORA ES NO JUGAR.";
  let i = ANIMAR ? 0 : texto.length - 1;
  const teclear = () => {
    if (!pantalla.isConnected) return;
    i += 1;
    pantalla.textContent = texto.slice(0, i) + (i < texto.length ? "█" : "");
    if (i < texto.length) setTimeout(teclear, texto[i - 1] === "\n" ? 240 : 36);
  };
  teclear();
}

function ojoHal() {
  mostrarHuevo("hal", [
    nodo("div", { className: "huevo-ojo" }),
    nodo("p", { className: "huevo-frase", textContent: "Lo siento, Dave. Me temo que no puedo hacer eso." }),
  ], 7000);
}

function mejorar() {
  mostrarHuevo("mejorar", [
    nodo("div", { className: "huevo-mira" }),
    nodo("p", { className: "huevo-frase", textContent: "Mejorar 224 a 176. Mejorar. Detener." }),
  ], 4500);
  map.easeTo({ zoom: Math.min(map.getZoom() + 2, 12), duration: ANIMAR ? 2500 : 0 });
}

const SECRETOS = { matrix: lluviaMatrix, neo: lluviaMatrix, arrival: logograma, joshua: juegoGuerra, hal: ojoHal, enhance: mejorar, mejorar };
const KONAMI = "ArrowUp ArrowUp ArrowDown ArrowDown ArrowLeft ArrowRight ArrowLeft ArrowRight b a";
function iniciarSecretos() {
  let letras = "";
  let teclas = [];
  document.addEventListener("keydown", (e) => {
    if (!estado.pro || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea")) return;
    teclas = [...teclas, e.key.length === 1 ? e.key.toLowerCase() : e.key].slice(-10);
    if (teclas.join(" ") === KONAMI) { teclas = []; lluviaMatrix(); return; }
    if (e.key.length !== 1) return;
    letras = (letras + e.key.toLowerCase()).slice(-12);
    const clave = Object.keys(SECRETOS).find((k) => letras.endsWith(k));
    if (clave) { letras = ""; SECRETOS[clave](); }
  });
}

/* Novedades: se muestran una vez por version, y avisan si hay una version nueva publicada */
let versionAvisada = null;
async function revisarVersion(inicio) {
  let v;
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return;
    v = await r.json();
  } catch { return; }
  if (v.version !== VERSION) {
    if (versionAvisada !== v.version) mostrarNovedades(v, true);
    versionAvisada = v.version;
  } else if (inicio && memoria.leer("version-vista") !== VERSION) {
    mostrarNovedades(v, false);
  }
}
function mostrarNovedades(v, nueva) {
  $("novedades-version").textContent = nueva ? `Hay una versión nueva (${v.version})` : `Versión ${v.version}`;
  $("novedades-lista").replaceChildren(...v.novedades.map((t) => nodo("li", { textContent: t })));
  $("novedades-recargar").hidden = !nueva;
  $("novedades").hidden = false;
}
function cerrarNovedades() {
  $("novedades").hidden = true;
  memoria.guardar("version-vista", VERSION);
}

function iniciarEventosMapa() {
  const globo = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
  map.on("mousemove", "comunas-relleno", (e) => {
    const f = e.features[0];
    if (!f?.properties.reg) { globo.remove(); return; }
    map.getCanvas().style.cursor = "pointer";
    const a = peor(alertasDe(f.properties.cut));
    const el = nodo("div", {}, f.properties.nombre, nodo("small", { textContent: a ? NIVELES[a.nivel].nombre : "Sin alerta" }));
    globo.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
  });
  map.on("mouseleave", "comunas-relleno", () => { map.getCanvas().style.cursor = ""; globo.remove(); });
  map.on("click", "comunas-relleno", (e) => {
    const f = e.features[0];
    if (f?.properties.reg) elegirComuna(f.properties.cut);
  });
}

function iniciarInterfaz() {
  $("tema").addEventListener("click", () => aplicarTema(document.documentElement.dataset.tema === "claro" ? "oscuro" : "claro"));
  ["mapa", "satelite", "pro"].forEach((b) => $(`base-${b}`).addEventListener("click", () => aplicarBase(b)));
  $("asa").addEventListener("click", () => $("panel").classList.toggle("alto"));
  $("novedades-cerrar").addEventListener("click", cerrarNovedades);
  $("novedades-recargar").addEventListener("click", () => location.reload());
  iniciarSecretos();
  $("puente").addEventListener("click", () => {
    const d = $("puente-detalle");
    d.hidden = !d.hidden;
    $("puente").setAttribute("aria-expanded", String(!d.hidden));
  });
  $("ver-intensidad").addEventListener("change", (e) => { estado.verIntensidad = e.target.checked; pintar(); });
  $("ver-antiguas").addEventListener("change", (e) => { estado.verAntiguas = e.target.checked; pintar(); dibujarPanel(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("huevo").hidden) cerrarHuevo();
    else if (e.key === "Escape" && !$("novedades").hidden) cerrarNovedades();
    else if (e.key === "Escape" && (estado.comunaSel != null || estado.alertaSel || estado.eventoSel)) limpiar();
  });
  if (innerWidth <= 760) $("leyenda").open = false;
}

aplicarTema(memoria.leer("tema") === "claro" ? "claro" : "oscuro");
iniciarInterfaz();
map.on("load", async () => {
  let comunas, regiones;
  try {
    [comunas, regiones] = await Promise.all([
      fetch("data/comunas.geojson").then((r) => r.json()),
      fetch("data/regiones.geojson").then((r) => r.json()),
    ]);
  } catch {
    $("contenido").replaceChildren(nodo("p", { className: "sin-datos", textContent: "No se pudo cargar el mapa. Revisa las alertas en senapred.cl." }));
    return;
  }
  prepararCapas(comunas, regiones);
  iniciarEventosMapa();
  iniciarBuscador();
  await cargarDatos();
  setInterval(cargarDatos, CADA_MS);
  setInterval(actualizarPuente, 30000);
  revisarVersion(true);
  setInterval(() => revisarVersion(false), 10 * 6e4);
});
