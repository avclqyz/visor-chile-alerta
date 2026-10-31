# Visor Chile Alerta

Mapa de Chile por comunas con las alertas y eventos que publica SENAPRED. Es un visor
ciudadano **no oficial**: no reemplaza a SENAPRED ni a los mensajes SAE.

- `web/`: la página. Es estática y se publica tal cual.
- `connector/`: el puente que lee SENAPRED y escribe `web/data/alertas.json`.
- `.github/workflows/actualizar.yml`: ejecuta el puente y publica la web.

## Publicar en GitHub

1. Crea un repositorio público en GitHub, por ejemplo `visor-chile-alerta`.
2. En el repositorio, entra a **Settings → Pages** y en **Source** elige **GitHub Actions**.
3. Sube este proyecto desde su carpeta, reemplazando `TU_USUARIO`:

```bash
git init -b main
git add .
git commit -m "Visor Chile Alerta"
git remote add origin https://github.com/TU_USUARIO/visor-chile-alerta.git
git push -u origin main
```

La web queda en `https://TU_USUARIO.github.io/visor-chile-alerta/`. El puente corre al subir
cambios y después cada 5 minutos. Para forzar una lectura: **Actions → Puente SENAPRED → Run workflow**.

## Probar en tu computador

```bash
python3 -m venv .venv
.venv/bin/pip install -r connector/requirements.txt
.venv/bin/python -m playwright install chromium
.venv/bin/python connector/actualizar.py
```

```bash
python3 -m http.server 4173 --directory web
```

Luego abre `http://localhost:4173`. Las pruebas se ejecutan con:

```bash
.venv/bin/python -m unittest discover connector/tests
```

## Cómo funciona el puente

SENAPRED no ofrece una API documentada. El puente abre `senapred.cl/alertas/` y `senapred.cl/eventos`
con un navegador real, como cualquier visitante, y guarda lo que la propia página recibe.

| Dato | Origen |
|---|---|
| Nivel (verde, amarillo, rojo) | Código de SENAPRED, contrastado con el título |
| Regiones | Campo estructurado de SENAPRED |
| Comunas y provincias | Interpretadas desde el título, porque SENAPRED las deja vacías |
| Vigencia | Título: "Se cancela" termina la alerta. El campo `isActive` no sirve para esto |
| Sismos | Intensidades Mercalli del texto y epicentro del catálogo del CSN |
| Volcanes | Tabla propia en `connector/volcanes.json`, coordenadas de referencia |
| Límites | Biblioteca del Congreso Nacional, simplificados para la web |

Reglas de seguridad:

- Si una lectura falla, queda incompleta o llega vacía, se conservan los últimos datos buenos.
- Si un territorio no se reconoce, se pinta la región completa y se marca como inferida.
- Si el título y el código difieren en el nivel, se usa el más severo.
- La web avisa si los datos tienen más de 30 minutos y, pasados 90, deja de afirmar que una comuna no tiene alertas.
- Una alerta sin cancelación sigue vigente, aunque lleve meses sin novedades. La web muestra esos días y permite ocultarlas.

## Límites conocidos

- Cualquier cambio en la web de SENAPRED puede romper la lectura. Si pasa, la web lo avisa con el banner rojo.
- GitHub no garantiza el horario de las tareas programadas: en horas punta el intervalo puede pasar de 5 minutos.
- SENAPRED publica por territorio administrativo, así que el mapa no muestra zonas exactas de riesgo.
- Una alerta pintada no significa que toda la comuna esté afectada: revisa siempre el detalle oficial.
- Los límites de BCN no incluyen la comuna de Antártica.
- Las imágenes satelitales son de Esri. Si la web crece o se usa con fines comerciales, revisa sus condiciones.

## Regenerar los límites

Fuente: [mapas vectoriales de BCN](https://www.bcn.cl/siit/mapas_vectoriales). Con `mapshaper`:

```bash
mapshaper -i comunas.shp encoding=utf8 -proj wgs84 -filter-islands min-area=1.5km2 remove-empty -simplify 2.2% weighted keep-shapes -clean -o comunas.geojson format=geojson precision=0.0001
```

Después se normalizan los nombres de regiones y provincias, por ejemplo Bío-Bío a Biobío.
