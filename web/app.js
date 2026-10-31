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
  frescura: "caido",
  fallosCarga: 0,
  marcas: [],
  marcaYo: null,
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
const opacidadRelleno = () => (estado.satelite ? 0.42 : 0.62);

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
  customAttribution: 'Límites: <a href="https://www.bcn.cl/siit/mapas_vectoriales" target="_blank" rel="noopener">BCN</a>',
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
    const info = { ...p, caja: cajaDe(f.geometry), geometria: f.geometry };
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
function dentroAnillo([x, y], r) {
  let dentro = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
function comunaEn(punto) {
  for (const c of estado.comunas.values()) {
    const [a, b, d, e] = c.caja;
    if (punto[0] < a || punto[0] > d || punto[1] < b || punto[1] > e) continue;
    if (poligonos(c.geometria).some((p) => dentroAnillo(punto, p[0]) && !p.slice(1).some((h) => dentroAnillo(punto, h)))) return c;
  }
  return null;
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
}

function dibujarMarcas(seleccion) {
  estado.marcas.forEach((m) => m.remove());
  estado.marcas = [];
  const agregar = (p, clase, col, titulo, accion) => {
    const el = nodo("button", {
      type: "button", className: `pin ${clase}`, title: titulo, ariaLabel: titulo,
      css: col ? { "--color": col } : {}, onclick: (ev) => { ev.stopPropagation(); accion(); },
    });
    estado.marcas.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
  };
  (seleccion ? [seleccion] : alertasVisibles()).forEach((a) => a.puntos.forEach((p) => {
    agregar(p, "volcan", NIVELES[a.nivel].css, `${p.nombre}: ${NIVELES[a.nivel].nombre}`, () => elegirAlerta(a.id));
  }));
  if (seleccion) return;
  estado.datos.eventos.forEach((e) => {
    if (!e.punto) return;
    const titulo = e.tipo === "sismo" ? `${e.titulo}${e.sismo.magnitud ? `, magnitud ${e.sismo.magnitud}` : ""}` : e.titulo;
    agregar(e.punto, e.punto.tipo === "epicentro" ? "epicentro" : "", null, titulo, () => elegirEvento(e.id));
  });
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
    e.punto?.tipo === "comuna" && nodo("p", { className: "meta", textContent: "El marcador está en el centro de la comuna, no en el lugar exacto." }),
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
function avisar(texto) {
  const m = $("mensaje");
  m.textContent = texto;
  m.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => { m.hidden = true; }, 4500);
}
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
  map.setPaintProperty("comunas-linea", "line-color", estado.satelite
    ? ["match", ["coalesce", ["feature-state", "nivel"], 0], 3, color("--roja"), 2, color("--amarilla"), 1, color("--verde"), "#ffffff"]
    : color("--tenue"));
  map.setPaintProperty("comunas-linea", "line-width", estado.satelite ? 1.6 : ["interpolate", ["linear"], ["zoom"], 3.5, 0.35, 8, 0.8]);
  map.setPaintProperty("regiones-linea", "line-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("cobertura-linea", "line-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("seleccion-linea", "line-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("etiquetas", "text-color", estado.satelite ? "#ffffff" : color("--texto"));
  map.setPaintProperty("etiquetas", "text-halo-color", estado.satelite ? "#000000" : color("--fondo"));
  map.setPaintProperty("comunas-relleno", "fill-opacity", opacidadRelleno());
}
function aplicarBase(satelite) {
  estado.satelite = satelite;
  $("base-mapa").setAttribute("aria-pressed", String(!satelite));
  $("base-satelite").setAttribute("aria-pressed", String(satelite));
  map.setLayoutProperty("satelite", "visibility", satelite ? "visible" : "none");
  map.setLayoutProperty("lugares", "visibility", satelite ? "visible" : "none");
  colorearMapa();
}
function usarUbicacion() {
  if (!navigator.geolocation) { avisar("Este navegador no permite obtener tu ubicación."); return; }
  $("ubicacion").classList.add("activo");
  navigator.geolocation.getCurrentPosition((pos) => {
    const p = [pos.coords.longitude, pos.coords.latitude];
    estado.marcaYo?.remove();
    estado.marcaYo = new maplibregl.Marker({ element: nodo("div", { className: "pin yo", title: "Tu ubicación" }) }).setLngLat(p).addTo(map);
    const c = comunaEn(p);
    if (c) elegirComuna(c.cut);
    else { map.flyTo({ center: p, zoom: Math.max(map.getZoom(), 7) }); avisar("Tu ubicación no está dentro de una comuna de Chile."); }
  }, () => {
    $("ubicacion").classList.remove("activo");
    avisar("No pudimos obtener tu ubicación. Revisa el permiso del navegador.");
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
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
  $("base-mapa").addEventListener("click", () => aplicarBase(false));
  $("base-satelite").addEventListener("click", () => aplicarBase(true));
  $("ubicacion").addEventListener("click", usarUbicacion);
  $("asa").addEventListener("click", () => $("panel").classList.toggle("alto"));
  $("puente").addEventListener("click", () => {
    const d = $("puente-detalle");
    d.hidden = !d.hidden;
    $("puente").setAttribute("aria-expanded", String(!d.hidden));
  });
  $("ver-intensidad").addEventListener("change", (e) => { estado.verIntensidad = e.target.checked; pintar(); });
  $("ver-antiguas").addEventListener("change", (e) => { estado.verAntiguas = e.target.checked; pintar(); dibujarPanel(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (estado.comunaSel != null || estado.alertaSel || estado.eventoSel)) limpiar();
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
});
