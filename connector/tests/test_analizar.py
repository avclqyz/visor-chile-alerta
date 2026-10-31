"""Pruebas con titulos reales publicados por SENAPRED. Ejecutar: python -m unittest discover connector/tests"""
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ / "connector"))

import analizar as an  # noqa: E402

TERRITORIO = an.Territorio(RAIZ / "web" / "data" / "comunas.geojson")
VOLCANES = json.loads((RAIZ / "connector" / "volcanes.json").read_text(encoding="utf-8"))
CAPTURA = json.loads((Path(__file__).parent / "fixtures" / "senapred.json").read_text(encoding="utf-8"))


def nombres(info):
    return sorted(TERRITORIO.comunas[c]["nombre"] for c in info["comunas"])


class Estado(unittest.TestCase):
    def test_monitoreo(self):
        self.assertEqual(an.interpretar_estado("Monitoreo Alerta Roja para la comuna de Arauco por remoción en masa"), ("roja", "monitoreo"))

    def test_cancelada_pura_no_queda_vigente(self):
        t = "Se cancela Alerta Temprana Preventiva para las provincias de Magallanes, Última Esperanza y Tierra del Fuego por altas temperaturas"
        self.assertEqual(an.interpretar_estado(t, "v")[1], "cancelada")

    def test_cancela_y_declara_sigue_vigente_con_el_nivel_nuevo(self):
        t = "Se cancela Alerta Amarilla y declara Alerta Temprana Preventiva para la Región de Arica y Parinacota por Alteración Sanitaria"
        self.assertEqual(an.interpretar_estado(t, "v"), ("verde", "declarada"))

    def test_declara_y_cancela_sigue_vigente_con_el_nivel_nuevo(self):
        t = "Se declara Alerta Roja y cancela Alerta Temprana Preventiva para las comunas de Pirque y Colina por remoción en masa"
        self.assertEqual(an.interpretar_estado(t, "r"), ("roja", "declarada"))

    def test_cancela_roja_comunal_y_declara_amarilla(self):
        t = "Se cancela Alerta Roja comunal y se declara Alerta Amarilla para las comunas de Pirque y Colina por remoción en masa"
        self.assertEqual(an.interpretar_estado(t, "a"), ("amarilla", "declarada"))


class TerritorioTitulos(unittest.TestCase):
    def test_comunas_con_articulo(self):
        t = "Monitoreo Alerta Roja para las comunas de San José de Maipo, Puente Alto, Pirque, La Florida, Peñalolén, La Reina, Las Condes, Lo Barnechea, Vitacura y Colina por remoción en masa"
        info = an.interpretar_territorio(t, TERRITORIO)
        self.assertEqual(info["sin_resolver"], [])
        self.assertEqual(len(info["comunas"]), 10)
        self.assertIn("La Florida", nombres(info))

    def test_region_con_conector_en_el_nombre(self):
        t = "Se cancela Alerta Amarilla y declara Alerta Temprana Preventiva para la Región de Arica y Parinacota por Alteración Sanitaria"
        info = an.interpretar_territorio(t, TERRITORIO)
        self.assertEqual((info["regiones"], info["sin_resolver"]), ([15], []))

    def test_provincias_mas_comunas(self):
        t = "Monitoreo Alerta Temprana Preventiva para las provincias de Los Andes y San Felipe y las comunas de La Ligua, Petorca y Cabildo por evento meteorológico"
        info = an.interpretar_territorio(t, TERRITORIO)
        self.assertEqual(info["sin_resolver"], [])
        self.assertEqual(len(info["provincias"]), 2)
        self.assertEqual(nombres(info), ["Cabildo", "La Ligua", "Petorca"])

    def test_region_como_calificador_no_cubre_toda_la_region(self):
        t = "Monitoreo Alerta Temprana Preventiva para las comunas de Villarrica, Pucón y Curarrehue en la Región de La Araucanía y para la comuna de Panguipulli en la Región de Los Ríos por actividad del Volcán Villarrica"
        info = an.interpretar_territorio(t, TERRITORIO)
        self.assertEqual(info["regiones"], [])
        self.assertEqual(nombres(info), ["Curarrehue", "Panguipulli", "Pucón", "Villarrica"])

    def test_provincia_y_comuna(self):
        t = "Se declara Alerta Temprana Preventiva para la Provincia de Parinacota y la comuna de Camarones por viento"
        info = an.interpretar_territorio(t, TERRITORIO)
        self.assertEqual((len(info["provincias"]), nombres(info), info["sin_resolver"]), (1, ["Camarones"], []))

    def test_comuna_con_tilde_y_caracteres_invisibles(self):
        self.assertIsNotNone(TERRITORIO.comuna("Valparaí­so"))
        self.assertIsNotNone(TERRITORIO.comuna("Curacaví­"))

    def test_todos_los_titulos_reales_se_resuelven(self):
        for item in CAPTURA["alertas"]:
            info = an.interpretar_territorio(item["titulo"], TERRITORIO)
            self.assertEqual(info["sin_resolver"], [], item["titulo"])
            self.assertTrue(info["comunas"] or info["provincias"] or info["regiones"], item["titulo"])


class Seguridad(unittest.TestCase):
    def regiones(self):
        uuid = {r["id"]: an.ROMANOS[r["codigo"]] for r in CAPTURA["regiones"]}
        return uuid, {an.ROMANOS[r["codigo"]]: r["nombre"] for r in CAPTURA["regiones"]}

    def item(self, titulo, region="XIII", codigo="v"):
        rid = next(r["id"] for r in CAPTURA["regiones"] if r["codigo"] == region)
        return {
            "id": "x", "titulo": titulo, "contenido": "<p>Texto</p>", "fechaHora": "2026-10-31T10:00:00.000-03:00",
            "urlAccess": "x", "regionesIds": [rid], "metaData": json.dumps({"codigoAlertaEvento": codigo}),
        }

    def test_territorio_desconocido_cubre_la_region_completa(self):
        uuid, nombre = self.regiones()
        alerta, avisos = an.analizar_alerta(self.item("Se declara Alerta Roja para la comuna de Inventada por viento", codigo="r"), TERRITORIO, uuid, nombre, VOLCANES)
        self.assertTrue(alerta["inferida"])
        self.assertEqual(len(alerta["comunas"]), len(TERRITORIO.por_region[13]))
        self.assertTrue(avisos)

    def test_nivel_contradictorio_usa_el_mas_severo(self):
        uuid, nombre = self.regiones()
        alerta, avisos = an.analizar_alerta(self.item("Monitoreo Alerta Amarilla para la comuna de Pirque por viento", codigo="r"), TERRITORIO, uuid, nombre, VOLCANES)
        self.assertEqual(alerta["nivel"], "roja")
        self.assertTrue(avisos)

    def test_html_de_origen_no_pasa_al_texto(self):
        self.assertEqual(an.html_a_parrafos("<p>Hola<script>alert(1)</script></p><img src=x onerror=y>"), ["Hola"])

    def test_tablas_quedan_en_una_linea_por_fila(self):
        html = "<table><tr><td><p>Aviso A595</p></td><td><p>Precipitaciones</p></td></tr><tr><td><p>Aviso A596</p></td><td><p>Viento</p></td></tr></table>"
        self.assertEqual(an.html_a_parrafos(html), ["Aviso A595 · Precipitaciones", "Aviso A596 · Viento"])


class Sismos(unittest.TestCase):
    def test_referencia_csn(self):
        r = an.referencia_sismo("se percibió a las 17:52 horas en la región. (PRELIMINAR) El Centro Sismológico Nacional indica que la magnitud del sismo fue de 4.3 y se localizó a 17 Kms al Norte de La Ligua.")
        self.assertEqual((r["magnitud"], r["hora"], r["km"], r["rumbo"], r["lugar"]), (4.3, (17, 52), 17, "norte", "La Ligua"))

    def test_magnitud_pegada_al_texto(self):
        self.assertEqual(an.referencia_sismo("la magnitud del sismo fue de 4.4y se localizó a 8 Kms al Sur de La Serena.")["magnitud"], 4.4)

    def test_intensidades_de_tabla_real(self):
        html = '<table><tr><td colspan="2"><p>Región: Coquimbo</p></td></tr><tr><td><p>Paiguano: </p></td><td><p>IV</p></td></tr><tr><td><p>Valparaí­so:</p></td><td><p>IV</p></td></tr></table>'
        inten, sin = an.intensidades_sismo(html, TERRITORIO)
        self.assertEqual((len(inten), sin), (2, []))

    def test_lugares_de_sismos_reales_salvo_ambiguos(self):
        # Llico existe en dos regiones, y El Loa y La Boca no identifican una sola comuna.
        ambiguos = {"El Loa", "Llico", "La Boca"}
        for item in CAPTURA["sismos"]:
            _, sin = an.intensidades_sismo(item["contenido"], TERRITORIO)
            self.assertEqual(set(sin) - ambiguos, set(), item["titulo"])

    def test_catalogo_csn_se_cruza_por_hora_y_magnitud(self):
        filas = an.filas_catalogo_csn(
            '<a href="/sismicidad/informes/2026/10/1.html">2026-10-26 17:51:30</a><br>17 km al N de La Ligua</td>'
            "<td>2026-10-26 20:51:30</td><td>-32.300<br> -71.230</td><td>60 km</td><td class=\"magnitud\">4.3 Mlv</td>"
        )
        ref = {"hora": (17, 52), "magnitud": 4.3}
        epi = an.epicentro_csn(filas, datetime(2026, 10, 26, 18, 2), ref)
        self.assertEqual((epi["lat"], epi["lon"], epi["aproximado"]), (-32.3, -71.23, False))
        self.assertIsNone(an.epicentro_csn(filas, datetime(2026, 10, 26, 18, 2), {"hora": (19, 0), "magnitud": 4.3}))


class Construccion(unittest.TestCase):
    def test_canceladas_no_llegan_al_mapa(self):
        crudo = {"alertas": CAPTURA["alertas"], "eventos": CAPTURA["sismos"], "regiones": CAPTURA["regiones"]}
        ahora = datetime(2026, 10, 31, 15, 30, tzinfo=timezone.utc)
        alertas, eventos, _ = an.construir(crudo, TERRITORIO, VOLCANES, lambda f: [], ahora)
        self.assertFalse([a for a in alertas if "se cancela alerta temprana preventiva para las provincias" in an.normalizar(a["titulo"])])
        self.assertEqual(alertas[0]["nivel"], "roja")
        for e in eventos:
            self.assertGreaterEqual(an.fecha_iso(e["fecha"]), ahora - timedelta(hours=48))

    def test_volcan_villarrica_tiene_punto(self):
        uuid = {r["id"]: an.ROMANOS[r["codigo"]] for r in CAPTURA["regiones"]}
        nombre = {an.ROMANOS[r["codigo"]]: r["nombre"] for r in CAPTURA["regiones"]}
        item = next(i for i in CAPTURA["alertas"] if "Volcán Villarrica" in i["titulo"])
        alerta, _ = an.analizar_alerta(item, TERRITORIO, uuid, nombre, VOLCANES)
        self.assertEqual([p["nombre"] for p in alerta["puntos"]], ["Volcán Villarrica"])


class PuenteCaido(unittest.TestCase):
    """Una lectura fallida nunca debe vaciar el mapa ni aparentar datos frescos."""

    def setUp(self):
        import actualizar
        self.ac = actualizar
        self.previo = {
            "meta": {"ultima_lectura_ok": "2026-10-31T10:00:00+00:00", "huella": "abc", "ultimo_cambio": "2026-10-31T09:00:00+00:00"},
            "alertas": [{"id": "sigue", "nivel": "roja", "comunas": [13101]}],
            "eventos": [],
        }

    def ejecutar_con(self, captura):
        with mock.patch.object(self.ac, "leer_previo", return_value=self.previo), \
             mock.patch.object(self.ac.senapred, "capturar", side_effect=captura):
            return self.ac.ejecutar()

    def comprobar_conserva(self, datos):
        self.assertEqual(datos["meta"]["estado"], "error")
        self.assertEqual(datos["meta"]["ultima_lectura_ok"], "2026-10-31T10:00:00+00:00")
        self.assertEqual([a["id"] for a in datos["alertas"]], ["sigue"])
        self.assertTrue(datos["meta"]["error"])

    def test_error_de_lectura_conserva_lo_ultimo_bueno(self):
        def fallar(_):
            raise self.ac.senapred.CapturaIncompleta("dejo de responder")
        self.comprobar_conserva(self.ejecutar_con(fallar))

    def test_lectura_vacia_se_rechaza(self):
        self.comprobar_conserva(self.ejecutar_con(lambda _: {"alertas": [], "eventos": [], "regiones": CAPTURA["regiones"]}))

    def test_lectura_sin_regiones_completas_se_rechaza(self):
        self.comprobar_conserva(self.ejecutar_con(lambda _: {"alertas": CAPTURA["alertas"], "eventos": [], "regiones": CAPTURA["regiones"][:3]}))

    def test_sin_datos_previos_no_inventa_lectura_correcta(self):
        self.previo = None
        def fallar(_):
            raise RuntimeError("sin red")
        datos = self.ejecutar_con(fallar)
        self.assertEqual(datos["alertas"], [])
        self.assertNotIn("ultima_lectura_ok", datos["meta"])

    def test_el_cambio_solo_avanza_si_cambia_el_contenido(self):
        crudo = {"alertas": CAPTURA["alertas"], "eventos": [], "regiones": CAPTURA["regiones"]}
        with mock.patch.object(self.ac.senapred, "lector_catalogo_csn", return_value=lambda f: []):
            uno = self.ejecutar_con(lambda _: crudo)
            self.assertEqual(uno["meta"]["estado"], "ok")
            self.previo = uno
            self.previo["meta"]["ultimo_cambio"] = "fijo"
            dos = self.ejecutar_con(lambda _: crudo)
        self.assertEqual(dos["meta"]["ultimo_cambio"], "fijo")


if __name__ == "__main__":
    unittest.main()
