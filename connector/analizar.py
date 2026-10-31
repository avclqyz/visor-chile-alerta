"""Convierte las publicaciones crudas de SENAPRED en datos listos para el mapa.

SENAPRED entrega el nivel y las regiones de forma estructurada, pero las comunas y
provincias solo aparecen en el titulo. Este modulo interpreta ese texto. Regla de
seguridad: ante la duda se muestra de mas, nunca de menos. Si un territorio no se
puede resolver, se usa la region completa y queda marcado como cobertura inferida.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path

VENTANA_EVENTOS_H = 48

NIVELES = {"verde": 1, "amarilla": 2, "roja": 3}
CODIGO_NIVEL = {"v": "verde", "a": "amarilla", "r": "roja"}
ROMANOS = {
    "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8,
    "IX": 9, "X": 10, "XI": 11, "XII": 12, "XIII": 13, "XIV": 14, "XV": 15, "XVI": 16,
}
REGIONES_ALIAS = {
    "tarapaca": 1, "antofagasta": 2, "atacama": 3, "coquimbo": 4, "valparaiso": 5,
    "o'higgins": 6, "ohiggins": 6, "libertador": 6, "maule": 7, "biobio": 8, "bio bio": 8,
    "bio-bio": 8, "araucania": 9, "la araucania": 9, "los lagos": 10, "aysen": 11,
    "aisen": 11, "magallanes": 12, "metropolitana": 13, "santiago": 13, "los rios": 14,
    "arica_parinacota": 15, "nuble": 16,
}
COMUNAS_ALIAS = {
    "paiguano": "paihuano", "llay llay": "llaillay", "llay-llay": "llaillay",
    "aisen": "aysen", "coihaique": "coyhaique", "marchihue": "marchigue",
    "alto bio bio": "alto biobio", "alto bio-bio": "alto biobio",
    "til til": "tiltil", "trehuaco": "treguaco", "natales": "puerto natales",
    "san vicente de tagua tagua": "san vicente", "rapa nui": "isla de pascua",
    "san pedro atacama": "san pedro de atacama", "padre de las casas": "padre las casas",
    "puerto saavedra": "saavedra",
    # Localidades que los informes de sismos citan como si fueran comunas.
    "san miguel de azapa": "arica", "poconchile": "arica", "pocon chile": "arica",
    "cuya": "camarones", "codpa": "camarones", "la tirana": "pozo almonte",
    "mamina": "pozo almonte", "pisagua": "huara", "chanavayita": "iquique",
    "ujina": "pica", "quillagua": "maria elena", "baquedano": "sierra gorda",
    "el salvador": "diego de almagro", "los loros": "tierra amarilla",
    "carrizal bajo": "huasco", "tongoy": "coquimbo", "iloca": "licanten",
    "nehuentue": "carahue", "bahia mansa": "san juan de la costa",
    "raul marin balmaceda": "cisnes", "puerto guadal": "chile chico",
}
PROVINCIAS_ALIAS = {"san felipe de aconcagua": "san felipe", "bio bio": "biobio", "bio-bio": "biobio", "nuble": "diguillin"}
ZONA_PARCIAL = re.compile(
    r"\b(precordillera|cordillera|cordillerano|litoral|borde costero|costa|costero|secano|"
    r"valle|zona|sector|sectores|interior|altiplano)\b[^,]*$"
)
EVENTO_CERRADO = re.compile(r"cierre de evento|se cancela")
MARCADOR = re.compile(r"\b(comunas?|provincias?|region(?:es)?)\b(?:\s+del?\b)?\s*")
MENCION_ALERTA = re.compile(r"alertas?\s+(temprana\s+preventiva|amarilla|roja|verde)")
VERBO = re.compile(
    r"\b(cancel\w*|declar\w*|monitoreo|modific\w*|manten\w*|mantiene|actualiz\w*|"
    r"extiend\w*|extension|ampli\w*|reduc\w*)"
)
NIVEL_TEXTO = {"temprana preventiva": "verde", "verde": "verde", "amarilla": "amarilla", "roja": "roja"}
ROMANO_RE = r"(XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)"
CATEGORIAS = (
    ("volcan", r"volc"),
    ("incendio", r"incendio"),
    ("tsunami", r"tsunami|marejada"),
    ("remocion", r"remocion|deslizamiento|aluvion"),
    ("crecida", r"crecida|inundacion|desborde|anegamiento"),
    ("sanitaria", r"sanitari|plaga|zoosanitari"),
    ("materiales", r"material"),
    ("meteorologia", r"meteorolog|viento|tormenta|precipitacion|nevada|temperatura|helada|frontal"),
)


def normalizar(texto: str) -> str:
    """Minusculas, sin tildes ni caracteres invisibles, para comparar nombres."""
    texto = (texto or "").replace("\u00ad", "").replace("\u200b", "").replace("\xa0", " ")
    texto = texto.replace("\u2019", "'").replace("\u00b4", "'").replace("`", "'")
    texto = unicodedata.normalize("NFKD", texto)
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", texto).strip().lower()


def fecha_iso(valor: str) -> datetime:
    """SENAPRED usa fracciones irregulares como 19:21:38.3838-03:00."""
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)?", valor or "")
    if not m:
        raise ValueError(f"fecha no reconocida: {valor!r}")
    zona = (m.group(2) or "-03:00").replace("Z", "+00:00")
    return datetime.fromisoformat(m.group(1) + zona)


class _Texto(HTMLParser):
    """Extrae parrafos de texto plano. El HTML de origen nunca llega a la web."""

    BLOQUE = {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "table", "ul", "ol", "br"}
    CELDA = {"td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.partes = []
        self.saltar = 0
        self.en_celda = 0
        self.celdas_fila = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.saltar += 1
        elif tag in self.CELDA:
            if self.celdas_fila:
                self.partes.append(" · ")
            self.celdas_fila += 1
            self.en_celda += 1
        elif tag == "tr":
            self.celdas_fila = 0
            self.partes.append("\n")
        elif tag in self.BLOQUE and not self.en_celda:
            self.partes.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.saltar = max(0, self.saltar - 1)
        elif tag in self.CELDA:
            self.en_celda = max(0, self.en_celda - 1)
        elif tag in self.BLOQUE and not self.en_celda:
            self.partes.append("\n")

    def handle_data(self, data):
        if not self.saltar:
            self.partes.append(data)


def html_a_parrafos(html: str):
    p = _Texto()
    p.feed(html or "")
    bruto = "".join(p.partes).replace("\u00ad", "").replace("\u200b", "").replace("\xa0", " ")
    return [t for t in (re.sub(r"[ \t]+", " ", l).strip() for l in bruto.split("\n")) if t]


class Territorio:
    """Comunas, provincias y regiones oficiales, cargadas desde la capa del mapa."""

    def __init__(self, ruta_geojson: Path):
        datos = json.loads(Path(ruta_geojson).read_text(encoding="utf-8"))
        self.comunas = {}
        self.por_nombre = {}
        self.provincias = {}
        self.por_region = {}
        self.por_provincia = {}
        for f in datos["features"]:
            p = f["properties"]
            if not p["reg"]:
                continue
            lon, lat = _centroide(f["geometry"])
            self.comunas[p["cut"]] = {**p, "lat": lat, "lon": lon}
            self.por_nombre[normalizar(p["nombre"])] = p["cut"]
            self.provincias[normalizar(p["provincia"])] = p["prov"]
            self.por_region.setdefault(p["reg"], []).append(p["cut"])
            self.por_provincia.setdefault(p["prov"], []).append(p["cut"])

    def comuna(self, nombre: str):
        n = normalizar(nombre)
        return self.por_nombre.get(COMUNAS_ALIAS.get(n, n))

    def provincia(self, nombre: str):
        n = normalizar(nombre)
        return self.provincias.get(PROVINCIAS_ALIAS.get(n, n))

    def region(self, nombre: str):
        n = normalizar(nombre)
        if n in REGIONES_ALIAS:
            return REGIONES_ALIAS[n]
        for alias, codigo in REGIONES_ALIAS.items():
            if re.search(rf"(^|\s){re.escape(alias)}($|\s)", n):
                return codigo
        return None


def _centroide(geom):
    """Centro del poligono mas grande, suficiente como punto de referencia."""
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]

    def area(anillo):
        return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(anillo, anillo[1:] + anillo[:1])) / 2

    anillo = max((p[0] for p in polys), key=lambda r: abs(area(r)))
    a = area(anillo) or 1e-9
    cx = sum((p[0] + q[0]) * (p[0] * q[1] - q[0] * p[1]) for p, q in zip(anillo, anillo[1:] + anillo[:1])) / (6 * a)
    cy = sum((p[1] + q[1]) * (p[0] * q[1] - q[0] * p[1]) for p, q in zip(anillo, anillo[1:] + anillo[:1])) / (6 * a)
    return round(cx, 4), round(cy, 4)


def interpretar_estado(titulo: str, codigo: str = ""):
    """Devuelve (nivel, estado). SENAPRED deja canceladas en la lista con isActive=true."""
    t = normalizar(titulo)
    verbos = [(m.start(), m.group(1)) for m in VERBO.finditer(t)]
    vigentes, canceladas = [], []
    for m in MENCION_ALERTA.finditer(t):
        nivel = NIVEL_TEXTO[re.sub(r"\s+", " ", m.group(1))]
        previos = [v for pos, v in verbos if pos < m.start()]
        (canceladas if previos and previos[-1].startswith("cancel") else vigentes).append(nivel)
    if canceladas and not vigentes:
        return canceladas[0], "cancelada"
    primero = verbos[0][1] if verbos else ""
    if vigentes:
        nivel = max(vigentes, key=NIVELES.get)
    else:
        nivel = CODIGO_NIVEL.get(codigo)
    if primero.startswith("declar") or (canceladas and vigentes):
        estado = "declarada"
    elif primero.startswith("modific") or primero.startswith("ampli") or primero.startswith("reduc"):
        estado = "modificada"
    elif primero.startswith("monitoreo") or primero.startswith("man"):
        estado = "monitoreo"
    else:
        estado = "vigente"
    return nivel, estado


def _limpiar_segmento(seg: str) -> str:
    seg = re.split(r"\s+por\s+|\s*\(|\s*:", seg)[0]
    while True:
        nuevo = re.sub(r"(?:\s|,|\b(?:y|e|para|en|la|las|el|los|de|del|entre|a|hasta)\b)+$", "", seg)
        if nuevo == seg:
            return seg.strip()
        seg = nuevo


def interpretar_territorio(titulo: str, territorio: Territorio):
    """Lee comunas, provincias y regiones declaradas en un titulo."""
    t = normalizar(titulo)
    t = re.sub(r"arica y parinacota", "arica_parinacota", t)
    t = re.sub(r"magallanes y (?:de )?(?:la )?antartica(?: chilena)?", "magallanes", t)
    salida = {"comunas": [], "provincias": [], "regiones": [], "sin_resolver": [], "parcial": False, "sectores": []}
    marcas = list(MARCADOR.finditer(t))
    for i, m in enumerate(marcas):
        fin = marcas[i + 1].start() if i + 1 < len(marcas) else len(t)
        seg = _limpiar_segmento(t[m.end():fin])
        tipo = m.group(1)[0]
        previo = t[max(0, m.start() - 14):m.start()]
        if tipo == "r":
            calificador = re.search(r"\ben (la|las)\s*$", previo) and any(
                salida[k] for k in ("comunas", "provincias")
            )
            if calificador:
                continue
            if ZONA_PARCIAL.search(t[:m.start()].rsplit(" para ", 1)[-1]):
                salida["parcial"] = True
        for nombre in re.split(r",|\s+y\s+|\s+e\s+", seg):
            nombre = re.sub(r"^(?:y|e|de|del)\s+", "", nombre.strip())
            if not nombre:
                continue
            if re.match(r"(sector|ruta|km|kilometro)\b", nombre):
                salida["sectores"].append(nombre)
                continue
            if tipo == "c":
                _agregar(salida, "comunas", territorio.comuna(nombre), nombre)
            elif tipo == "p":
                _agregar(salida, "provincias", territorio.provincia(nombre), nombre)
            else:
                _agregar(salida, "regiones", territorio.region(nombre), nombre)
    return salida


def _agregar(salida, clave, valor, nombre):
    if valor is None:
        salida["sin_resolver"].append(nombre)
    elif valor not in salida[clave]:
        salida[clave].append(valor)


def categoria_de(texto: str) -> str:
    t = normalizar(texto)
    for clave, patron in CATEGORIAS:
        if re.search(patron, t):
            return clave
    return "otro"


def amenaza_de(titulo: str, variable: str) -> str:
    limpio = re.sub(r"\s+", " ", titulo).strip()
    partes = re.split(r"\s+por\s+", limpio)
    if len(partes) > 1:
        texto = partes[-1].strip(" .")
        return texto[0].upper() + texto[1:]
    return variable or "Sin especificar"


def extraer_sectores(parrafos):
    """Lista sectores con nombre propio. No se geolocalizan: solo se muestran como texto."""
    texto = " ".join(parrafos)
    hallados = []
    for m in re.finditer(
        r"\bsector(?:es)?\s+(?:de\s+(?:la\s+|las\s+|los\s+|el\s+)?|del\s+)?"
        r"((?:[A-ZÁÉÍÓÚÑ][\wáéíóúñü'.-]*)(?:(?:\s+(?:de|del|la|las|los|el|y)\s+|\s+|,\s+|\s+-\s+)[A-ZÁÉÍÓÚÑ0-9][\wáéíóúñü'.-]*)*)",
        texto,
    ):
        nombre = m.group(1).strip(" .,")
        for parte in re.split(r",\s+|\s+y\s+", nombre):
            parte = parte.strip()
            if len(parte) >= 3 and parte not in hallados and normalizar(parte) not in ("precipitaciones", "cordillera", "valle"):
                hallados.append(parte)
    return hallados[:12]


def buscar_volcanes(titulo: str, volcanes):
    t = normalizar(titulo)
    if "volcan" not in t:
        return []
    return [
        {"nombre": v["nombre"], "lat": v["lat"], "lon": v["lon"], "tipo": "volcan"}
        for v in volcanes
        if any(a in t for a in v["busqueda"])
    ]


def _expandir(info, territorio: Territorio):
    cuts = list(info["comunas"])
    for prov in info["provincias"]:
        cuts += territorio.por_provincia.get(prov, [])
    for reg in info["regiones"]:
        cuts += territorio.por_region.get(reg, [])
    return sorted(set(cuts))


def _etiqueta(info, cut_lista, territorio: Territorio, regiones_nombre):
    partes = []
    if info["regiones"]:
        partes.append(", ".join(regiones_nombre.get(r, f"Región {r}") for r in info["regiones"]))
    if info["provincias"]:
        nombres = {territorio.comunas[c]["prov"]: territorio.comunas[c]["provincia"] for c in cut_lista}
        partes.append("Provincia" + ("s" if len(info["provincias"]) > 1 else "") + " de " + ", ".join(nombres.get(p, str(p)) for p in info["provincias"]))
    if info["comunas"]:
        n = len(info["comunas"])
        partes.append(("Comuna de " if n == 1 else f"{n} comunas: ") + ", ".join(territorio.comunas[c]["nombre"] for c in info["comunas"]))
    return " · ".join(partes)


def analizar_alerta(item, territorio, regiones_uuid, regiones_nombre, volcanes):
    """Devuelve la alerta lista para el mapa, o None si esta cancelada."""
    meta = json.loads(item.get("metaData") or "{}")
    titulo = re.sub(r"\s+", " ", item.get("titulo") or "").strip()
    codigo = meta.get("codigoAlertaEvento", "")
    nivel, estado = interpretar_estado(titulo, codigo)
    if estado == "cancelada":
        return None, []
    avisos = []
    nivel_codigo = CODIGO_NIVEL.get(codigo)
    if nivel is None and nivel_codigo is None:
        avisos.append(f"Nivel desconocido: {titulo}")
        nivel = "amarilla"
    elif nivel is None:
        nivel = nivel_codigo
    elif nivel_codigo and nivel_codigo != nivel:
        avisos.append(f"Titulo ({nivel}) y codigo ({nivel_codigo}) difieren, se usa el mas severo: {titulo}")
        nivel = max((nivel, nivel_codigo), key=NIVELES.get)

    info = interpretar_territorio(titulo, territorio)
    regs_oficiales = sorted({regiones_uuid[r] for r in item.get("regionesIds") or [] if r in regiones_uuid})
    comunas = _expandir(info, territorio)
    inferida = False
    if info["sin_resolver"] or not comunas:
        if info["sin_resolver"]:
            avisos.append(f"Territorio sin resolver {info['sin_resolver']}: {titulo}")
        info["regiones"] = sorted(set(info["regiones"]) | set(regs_oficiales))
        comunas = _expandir(info, territorio)
        inferida = True
    if not comunas:
        avisos.append(f"Alerta sin territorio identificable: {titulo}")
    fuera = [c for c in comunas if regs_oficiales and territorio.comunas[c]["reg"] not in regs_oficiales]
    if fuera:
        avisos.append(f"{len(fuera)} comunas fuera de las regiones declaradas: {titulo}")

    variable = (item.get("variableRiesgo") or {}).get("nombre") or ""
    amenaza = amenaza_de(titulo, variable)
    parrafos = html_a_parrafos(item.get("contenido"))
    return (
        {
            "id": item["id"],
            "titulo": titulo,
            "url": f"https://senapred.cl/alerta/{item.get('urlAccess')}",
            "nivel": nivel,
            "estado": estado,
            "amenaza": amenaza,
            "categoria": categoria_de(f"{amenaza} {variable}"),
            "actualizada": fecha_iso(item["fechaHora"]).isoformat(),
            "cobertura": _etiqueta(info, comunas, territorio, regiones_nombre) if comunas else "Sin identificar",
            "parcial": info["parcial"],
            "inferida": inferida,
            "regiones": regs_oficiales,
            "comunas": comunas,
            "puntos": buscar_volcanes(titulo, volcanes),
            "sectores": extraer_sectores(parrafos),
            "texto": parrafos,
        },
        avisos,
    )


def intensidades_sismo(parrafos_html: str, territorio: Territorio):
    """Lee la tabla de intensidades Mercalli. Devuelve ({cut: romano}, nombres no resueltos)."""
    salida, sin = {}, []
    for fila in re.findall(r"<tr[^>]*>(.*?)</tr>", parrafos_html or "", re.S | re.I):
        celdas = [" ".join(html_a_parrafos(c)) for c in re.findall(r"<td[^>]*>(.*?)</td>", fila, re.S | re.I)]
        if len(celdas) < 2:
            continue
        nombre = celdas[0].rstrip(": ").strip()
        valor = celdas[1].strip().upper()
        if not re.fullmatch(ROMANO_RE, valor) or normalizar(nombre).startswith("region"):
            continue
        cut = territorio.comuna(nombre)
        if cut is None:
            sin.append(nombre)
        elif ROMANOS[valor] > ROMANOS.get(salida.get(cut), 0):
            salida[cut] = valor
    return salida, sin


RUMBOS = {
    "norte": 0, "noreste": 45, "este": 90, "sureste": 135, "sur": 180, "suroeste": 225,
    "oeste": 270, "noroeste": 315,
}


def referencia_sismo(texto: str):
    """Extrae magnitud, hora y referencia desde el parrafo del Centro Sismologico Nacional."""
    n = normalizar(texto)
    salida = {"magnitud": None, "hora": None, "km": None, "rumbo": None, "lugar": None}
    m = re.search(r"magnitud del sismo fue(?: de)?\s*(\d+(?:[.,]\d+)?)", n)
    if m:
        salida["magnitud"] = float(m.group(1).replace(",", "."))
    m = re.search(r"percibio a las (\d{1,2}):(\d{2})", n)
    if m:
        salida["hora"] = (int(m.group(1)), int(m.group(2)))
    original = re.sub(r"\s+", " ", (texto or "").replace("\u00ad", ""))
    m = re.search(
        r"(\d+)\s*(?:kms?|kil[oó]metros?)\.?\s+al\s+([a-záéíóú]+)\s+de\s+([^.]+?)\s*(?:\.|$|SHOA)",
        original,
        re.I,
    )
    if m:
        salida["km"] = int(m.group(1))
        salida["rumbo"] = normalizar(m.group(2))
        salida["lugar"] = m.group(3).strip()
    return salida


def desplazar(lat, lon, km, rumbo):
    grados = RUMBOS[rumbo]
    dlat = km / 110.574 * math.cos(math.radians(grados))
    dlon = km / (111.32 * math.cos(math.radians(lat))) * math.sin(math.radians(grados))
    return round(lat + dlat, 3), round(lon + dlon, 3)


FILA_CSN = re.compile(
    r'<a href="(?P<url>/sismicidad/informes/[^"]+)">(?P<fecha>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)</a><br>\s*(?P<lugar>[^<]*?)\s*</td>\s*'
    r"<td>[^<]*</td>\s*<td>(?P<lat>-?\d+\.\d+)<br>\s*(?P<lon>-?\d+\.\d+)</td>\s*<td>(?P<prof>\d+)\s*km</td>\s*"
    r'<td class="magnitud">(?P<mag>\d+(?:\.\d+)?)',
    re.S,
)


def filas_catalogo_csn(html: str):
    return [
        {
            "url": "https://www.sismologia.cl" + f.group("url"),
            "fecha": datetime.strptime(f.group("fecha"), "%Y-%m-%d %H:%M:%S"),
            "lugar": f.group("lugar"),
            "lat": float(f.group("lat")),
            "lon": float(f.group("lon")),
            "prof": int(f.group("prof")),
            "mag": float(f.group("mag")),
        }
        for f in FILA_CSN.finditer(html)
    ]


def epicentro_csn(filas, fecha_evento: datetime, ref):
    """Cruza con el catalogo del CSN por hora y magnitud. Sin coincidencia clara devuelve None."""
    if not ref["hora"]:
        return None
    objetivo = fecha_evento.replace(hour=ref["hora"][0], minute=ref["hora"][1], second=0, tzinfo=None)
    candidatos = []
    for f in filas:
        minutos = abs((f["fecha"] - objetivo).total_seconds()) / 60
        if minutos > 8:
            continue
        if ref["magnitud"] is not None and abs(f["mag"] - ref["magnitud"]) > 0.4:
            continue
        candidatos.append((minutos, f))
    if not candidatos:
        return None
    _, f = min(candidatos, key=lambda c: c[0])
    return {"lat": f["lat"], "lon": f["lon"], "prof_km": f["prof"], "aproximado": False, "fuente": "Centro Sismológico Nacional", "url": f["url"], "lugar": f["lugar"]}


def analizar_evento(item, territorio, regiones_uuid, catalogo_csn):
    titulo = re.sub(r"\s+", " ", item.get("titulo") or "").strip()
    avisos = []
    fecha = fecha_iso(item["fechaHora"])
    variable = (item.get("variableInformate") or {}).get("nombre") or ""
    es_sismo = normalizar(variable) in ("sismo", "terremoto") or normalizar(titulo).startswith(("sismo", "terremoto"))
    parrafos = html_a_parrafos(item.get("contenido"))
    info = interpretar_territorio(titulo, territorio) if "entre las regiones" not in normalizar(titulo) else {"comunas": [], "provincias": [], "regiones": [], "sin_resolver": []}
    regs_oficiales = sorted({regiones_uuid[r] for r in item.get("regionesIds") or [] if r in regiones_uuid})
    salida = {
        "id": item["id"],
        "titulo": titulo,
        "url": f"https://senapred.cl/evento/{item.get('urlAccess')}",
        "tipo": "sismo" if es_sismo else "evento",
        "variable": variable,
        "categoria": "sismo" if es_sismo else categoria_de(f"{titulo} {variable}"),
        "fecha": fecha.isoformat(),
        "regiones": regs_oficiales,
        "comunas": sorted(set(info["comunas"])),
        "texto": parrafos,
        "punto": None,
    }
    if es_sismo:
        inten, sin_ubicar = intensidades_sismo(item.get("contenido"), territorio)
        ref = referencia_sismo(" ".join(parrafos))
        epi = epicentro_csn(catalogo_csn(fecha), fecha, ref)
        if epi is None and ref["lugar"] and ref["rumbo"] in RUMBOS:
            cut = territorio.comuna(ref["lugar"])
            if cut:
                base = territorio.comunas[cut]
                lat, lon = desplazar(base["lat"], base["lon"], ref["km"], ref["rumbo"])
                epi = {"lat": lat, "lon": lon, "prof_km": None, "aproximado": True, "fuente": "Estimado desde la referencia de SENAPRED", "url": None, "lugar": None}
        referencia = f"{ref['km']} km al {ref['rumbo']} de {ref['lugar']}" if ref["lugar"] else None
        orden = sorted(inten.values(), key=ROMANOS.get)
        salida["sismo"] = {
            "magnitud": ref["magnitud"],
            "referencia": referencia,
            "intensidades": {str(k): v for k, v in inten.items()},
            "intensidad_max": orden[-1] if orden else None,
            "sin_ubicar": sin_ubicar,
            "epicentro": epi,
        }
        if epi:
            salida["punto"] = {"lat": epi["lat"], "lon": epi["lon"], "aproximado": epi["aproximado"], "tipo": "epicentro"}
    elif len(salida["comunas"]) == 1:
        c = territorio.comunas[salida["comunas"][0]]
        salida["punto"] = {"lat": c["lat"], "lon": c["lon"], "aproximado": True, "tipo": "comuna"}
    return salida, avisos


def evento_cerrado(titulo: str) -> bool:
    return bool(EVENTO_CERRADO.search(normalizar(titulo)))


def construir(crudo, territorio: Territorio, volcanes, catalogo_csn, ahora: datetime):
    """Transforma una captura completa. Devuelve (alertas, eventos, avisos)."""
    regiones_uuid = {r["id"]: ROMANOS[r["codigo"]] for r in crudo["regiones"] if r.get("codigo") in ROMANOS}
    regiones_nombre = {ROMANOS[r["codigo"]]: r["nombre"] for r in crudo["regiones"] if r.get("codigo") in ROMANOS}
    alertas, avisos = [], []
    for item in crudo["alertas"]:
        alerta, av = analizar_alerta(item, territorio, regiones_uuid, regiones_nombre, volcanes)
        avisos += av
        if alerta:
            alertas.append(alerta)
    alertas.sort(key=lambda a: a["actualizada"], reverse=True)
    alertas.sort(key=lambda a: NIVELES[a["nivel"]], reverse=True)
    eventos = []
    limite = ahora - timedelta(hours=VENTANA_EVENTOS_H)
    for item in crudo["eventos"]:
        if evento_cerrado(item.get("titulo") or "") or fecha_iso(item["fechaHora"]) < limite:
            continue
        evento, av = analizar_evento(item, territorio, regiones_uuid, catalogo_csn)
        avisos += av
        eventos.append(evento)
    eventos.sort(key=lambda e: e["fecha"], reverse=True)
    return alertas, eventos, avisos
