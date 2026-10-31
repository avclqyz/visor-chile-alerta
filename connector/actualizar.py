"""Puente SENAPRED -> web: lee, valida y escribe web/data/alertas.json.

Si la lectura falla no se borra nada: se conservan los ultimos datos buenos y se deja
constancia del error para que la web avise que pueden estar desactualizados.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import traceback
from pathlib import Path

import analizar as an
import senapred

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "web" / "data" / "alertas.json"
GEO = RAIZ / "web" / "data" / "comunas.geojson"
VOLCANES = Path(__file__).resolve().parent / "volcanes.json"
ESQUEMA = 1


def leer_previo():
    try:
        return json.loads(SALIDA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def huella(alertas, eventos) -> str:
    """Identifica el contenido publicado, ignorando las marcas de tiempo del puente."""
    base = json.dumps({"a": alertas, "e": eventos}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]


def totales(alertas, eventos):
    resumen = {"verde": 0, "amarilla": 0, "roja": 0}
    for a in alertas:
        resumen[a["nivel"]] += 1
    comunas = {c for a in alertas for c in a["comunas"]}
    return {**resumen, "alertas": len(alertas), "comunas_con_alerta": len(comunas), "eventos": len(eventos)}


def validar(crudo):
    """Rechaza lecturas imposibles antes de que reemplacen a los datos buenos."""
    if not crudo["alertas"]:
        raise senapred.CapturaIncompleta("SENAPRED no entrego ninguna publicacion de alertas")
    if len(crudo["regiones"]) != 16:
        raise senapred.CapturaIncompleta(f"Se esperaban 16 regiones y llegaron {len(crudo['regiones'])}")


def ejecutar():
    ahora = senapred.ahora_utc()
    previo = leer_previo()
    meta_previa = (previo or {}).get("meta", {})
    try:
        crudo = senapred.capturar(ahora)
        validar(crudo)
        territorio = an.Territorio(GEO)
        volcanes = json.loads(VOLCANES.read_text(encoding="utf-8"))
        alertas, eventos, avisos = an.construir(crudo, territorio, volcanes, senapred.lector_catalogo_csn(), ahora)
    except Exception as error:
        traceback.print_exc()
        print(f"::warning::Puente sin datos nuevos: {error}")
        salida = previo or {"alertas": [], "eventos": [], "meta": {}}
        salida["meta"] = {
            **meta_previa,
            "esquema": ESQUEMA,
            "estado": "error",
            "ultimo_intento": ahora.isoformat(),
            "error": str(error)[:300],
        }
        return salida

    h = huella(alertas, eventos)
    cambio = meta_previa.get("ultimo_cambio") if meta_previa.get("huella") == h else ahora.isoformat()
    fechas = [an.fecha_iso(i["fechaHora"]) for i in crudo["alertas"] + crudo["eventos"]]
    for aviso in avisos:
        print(f"::warning::{aviso}")
    return {
        "meta": {
            "esquema": ESQUEMA,
            "estado": "ok",
            "fuente": senapred.URL_ALERTAS,
            "ultimo_intento": ahora.isoformat(),
            "ultima_lectura_ok": ahora.isoformat(),
            "ultimo_cambio": cambio,
            "ultima_publicacion_senapred": max(fechas).isoformat(),
            "huella": h,
            "error": None,
            "avisos": avisos,
            "ventana_eventos_h": an.VENTANA_EVENTOS_H,
            "totales": totales(alertas, eventos),
        },
        "alertas": alertas,
        "eventos": eventos,
    }


def escribir(datos):
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    temporal = SALIDA.with_suffix(".tmp")
    temporal.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporal, SALIDA)


def main() -> int:
    datos = ejecutar()
    escribir(datos)
    meta = datos["meta"]
    print(f"Estado: {meta.get('estado')} | intento: {meta.get('ultimo_intento')} | totales: {meta.get('totales')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
