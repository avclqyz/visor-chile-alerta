// Pide a GitHub ejecutar el puente, porque su horario propio llega con unos 35 minutos de atraso.
const FLUJO = "https://api.github.com/repos/avclqyz/visor-chile-alerta/actions/workflows/actualizar.yml/dispatches";

export default {
  async scheduled(_evento, env) {
    const respuesta = await fetch(FLUJO, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "visor-chile-alerta",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (!respuesta.ok) throw new Error(`GitHub respondio ${respuesta.status}`);
  },
};
