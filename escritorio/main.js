// Ventana de escritorio para el visor publicado. Carga la web en linea, asi recibe
// cada actualizacion y su aviso de novedades sin reinstalar nada.
const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");

const SITIO = "https://avclqyz.github.io/visor-chile-alerta/";
const ORIGEN = new URL(SITIO).origin;
const RUTA = new URL(SITIO).pathname;
const esDelSitio = (url) => {
  try {
    const u = new URL(url);
    return u.origin === ORIGEN && u.pathname.startsWith(RUTA);
  } catch { return false; }
};
const abrirFuera = (url) => {
  if (url.startsWith("https://")) shell.openExternal(url);
};

function crearVentana() {
  const ventana = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Visor Chile Alerta",
    backgroundColor: "#0b0e12",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Los enlaces externos (SENAPRED, CSN) se abren en el navegador del sistema.
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    abrirFuera(url);
    return { action: "deny" };
  });
  ventana.webContents.on("will-navigate", (evento, url) => {
    if (esDelSitio(url)) return;
    evento.preventDefault();
    abrirFuera(url);
  });
  ventana.webContents.on("did-fail-load", (_e, _codigo, _desc, url, principal) => {
    if (principal && esDelSitio(url)) ventana.loadFile(path.join(__dirname, "sin-conexion.html"));
  });
  ventana.loadURL(SITIO);
}

app.whenReady().then(() => {
  crearVentana();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
