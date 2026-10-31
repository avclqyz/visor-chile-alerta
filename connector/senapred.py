"""Lee las paginas publicas de SENAPRED con un navegador real.

SENAPRED no ofrece una API documentada. Este modulo abre senapred.cl como cualquier
visitante, deja que la pagina haga sus propias consultas y guarda lo que recibe.
Asi no depende de credenciales internas y sigue funcionando si la web las cambia.
"""
from __future__ import annotations

import urllib.request
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright

from analizar import VENTANA_EVENTOS_H, filas_catalogo_csn, fecha_iso

URL_ALERTAS = "https://senapred.cl/alertas/"
URL_EVENTOS = "https://senapred.cl/eventos"
URL_CATALOGO_CSN = "https://www.sismologia.cl/sismicidad/catalogo/{a:%Y/%m/%Y%m%d}.html"
AGENTE = "VisorChileAlerta/1.0 (visor ciudadano no oficial; lee paginas publicas)"
MAX_PAGINAS = 80
ESPERA_MS = 20000


class CapturaIncompleta(RuntimeError):
    """La lectura no llego al final. Publicar datos parciales ocultaria alertas."""


def _recorrer(page, url, pendientes, listo):
    """Abre una lista y avanza con >> hasta que `listo` confirma que no hace falta mas."""
    page.goto(url, wait_until="networkidle", timeout=60000)
    for _ in range(MAX_PAGINAS):
        if not pendientes:
            page.wait_for_timeout(ESPERA_MS / 4)
        if not pendientes:
            raise CapturaIncompleta(f"{url} no entrego datos")
        if listo():
            return
        vistos = len(pendientes)
        page.get_by_text(">>", exact=True).first.click(timeout=ESPERA_MS)
        for _ in range(int(ESPERA_MS / 250)):
            page.wait_for_timeout(250)
            if len(pendientes) > vistos:
                break
        else:
            raise CapturaIncompleta(f"{url} dejo de responder en la pagina {vistos}")
    raise CapturaIncompleta(f"{url} supero {MAX_PAGINAS} paginas")


def capturar(ahora: datetime):
    """Devuelve {'regiones', 'alertas', 'eventos'} completos o lanza CapturaIncompleta."""
    paginas = {"alertas": [], "eventos": []}
    regiones = []
    limite_eventos = ahora - timedelta(hours=VENTANA_EVENTOS_H + 2)

    def al_responder(resp):
        if "appsync-api" not in resp.url or resp.request.method != "POST":
            return
        try:
            datos = resp.json().get("data") or {}
        except Exception:
            return
        for clave, destino in (("alertasByDate", "alertas"), ("eventosByDate", "eventos")):
            if datos.get(clave):
                paginas[destino].append(datos[clave])
        if datos.get("regionesByCodigo"):
            regiones[:] = datos["regionesByCodigo"]["items"]

    def alertas_listas():
        return not paginas["alertas"][-1].get("nextToken")

    def eventos_listos():
        ultima = paginas["eventos"][-1]
        if not ultima.get("nextToken"):
            return True
        return any(fecha_iso(i["fechaHora"]) < limite_eventos for i in ultima["items"])

    with sync_playwright() as p:
        navegador = p.chromium.launch(headless=True)
        try:
            contexto = navegador.new_context(locale="es-CL", user_agent=AGENTE)
            page = contexto.new_page()
            page.on("response", al_responder)
            _recorrer(page, URL_ALERTAS, paginas["alertas"], alertas_listas)
            _recorrer(page, URL_EVENTOS, paginas["eventos"], eventos_listos)
        finally:
            navegador.close()

    if not regiones:
        raise CapturaIncompleta("No llego la lista de regiones")
    return {
        "regiones": regiones,
        "alertas": _sin_repetir(paginas["alertas"]),
        "eventos": _sin_repetir(paginas["eventos"]),
    }


def _sin_repetir(paginas):
    unicos = {}
    for pagina in paginas:
        for item in pagina["items"]:
            unicos[item["id"]] = item
    return list(unicos.values())


def lector_catalogo_csn():
    """Devuelve una funcion fecha -> filas del catalogo del CSN, con memoria por dia."""
    memoria = {}

    def leer(fecha: datetime):
        clave = fecha.date()
        if clave not in memoria:
            try:
                pedido = urllib.request.Request(URL_CATALOGO_CSN.format(a=fecha), headers={"User-Agent": AGENTE})
                with urllib.request.urlopen(pedido, timeout=25) as r:
                    memoria[clave] = filas_catalogo_csn(r.read().decode("utf-8", "ignore"))
            except Exception:
                memoria[clave] = []
        return memoria[clave]

    return leer


def ahora_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)
