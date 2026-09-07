// build.mjs — genera data.json para el reporte semanal de Viralium
// Se ejecuta solo cada lunes desde GitHub Actions. Node 20+, sin dependencias.

const CONFIG = {
  cuentaInstagram: 'xavierlopezvega',
  canalYouTube: 'Cuéntanos Tu Éxito',
  playlistId: 'PLNkJvjSA8IT9JD5JmzXvJHVA1ewML_DUC',
  duracionMinimaMin: 20,      // por debajo de esto no es episodio, es clip
  episodiosReferencia: 20,    // cuántos episodios pasados entran en la mediana
  comentariosMostrados: 8,
  zona: 'Europe/Madrid'
};

const SHEET_CSV = process.env.SHEET_CSV_URL;   // Sheet de Sort Feed publicado como CSV
const YT_KEY    = process.env.YOUTUBE_API_KEY;

// ---------------------------------------------------------------- utilidades

const yt = async (endpoint, params) => {
  const q = new URLSearchParams({ ...params, key: YT_KEY });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${q}`);
  if (!r.ok) throw new Error(`YouTube ${endpoint}: ${r.status} ${await r.text()}`);
  return r.json();
};

const chunk = (arr, n) => arr.reduce((a, _, i) => (i % n ? a : [...a, arr.slice(i, i + n)]), []);

const isoADurac = iso => {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  const [h, mi, s] = [+(m[1] || 0), +(m[2] || 0), +(m[3] || 0)];
  return { minutos: h * 60 + mi + s / 60, texto: h ? `${h}h ${mi}min` : `${mi} min` };
};

const mediana = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const diaSemana = f => new Date(f).toLocaleDateString('es-ES', { weekday: 'long', timeZone: CONFIG.zona });

// Parser CSV que aguanta comas y saltos de línea dentro de comillas
function parseCSV(texto) {
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const cab = filas.shift().map(h => h.trim().toLowerCase());
  return filas.filter(f => f.some(v => v.trim()))
              .map(f => Object.fromEntries(cab.map((h, i) => [h, (f[i] || '').trim()])));
}

// ------------------------------------------------------- Instagram (Sort Feed)

// AJUSTAR AQUÍ cuando sepamos los nombres exactos de columna de tu exportación.
// Cada entrada busca la primera columna que exista de la lista.
const COLUMNAS = {
  url:         ['reel', 'url', 'link', 'permalink'],
  fecha:       ['create date', 'date', 'fecha', 'timestamp'],
  titulo:      ['titulo', 'título', 'caption', 'description'],   // opcional
  vistas:      ['views', 'plays', 'reproducciones'],
  likes:       ['likes', 'me gusta'],
  comentarios: ['comments', 'comentarios'],
  outlier:     ['outlier score', 'outlier']
};

const campo = (fila, claves) => {
  for (const k of claves) if (fila[k] !== undefined && fila[k] !== '') return fila[k];
  return '';
};
const aNumero = v => Number(String(v).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
const shortcode = url => (String(url).match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/) || [])[1] || '';

async function instagram(desde, hasta) {
  const csv = await fetch(SHEET_CSV).then(r => r.text());
  const reels = parseCSV(csv).map(f => {
    const fecha = new Date(campo(f, COLUMNAS.fecha));
    if (isNaN(fecha)) return null;
    return {
      fecha: fecha.toISOString().slice(0, 10),
      dia: diaSemana(fecha),
      shortcode: shortcode(campo(f, COLUMNAS.url)),
      titulo: campo(f, COLUMNAS.titulo).split('\n')[0].slice(0, 95),
      vistas: aNumero(campo(f, COLUMNAS.vistas)),
      likes: aNumero(campo(f, COLUMNAS.likes)),
      comentarios: aNumero(campo(f, COLUMNAS.comentarios)),
      outlier: aNumero(campo(f, COLUMNAS.outlier))
    };
  })
  .filter(Boolean)
  .filter(r => r.shortcode && r.fecha >= desde && r.fecha <= hasta)
  .sort((a, b) => b.vistas - a.vistas);

  if (!reels.length) throw new Error(`El Sheet no trae ningún reel entre ${desde} y ${hasta}. ¿Se exportó?`);
  return { cuenta: CONFIG.cuentaInstagram, reels };
}

// ------------------------------------------------------------------- YouTube

async function youtube() {
  // 1. todos los vídeos de la playlist de episodios
  let ids = [], token;
  do {
    const p = await yt('playlistItems', {
      part: 'contentDetails', playlistId: CONFIG.playlistId, maxResults: 50, ...(token && { pageToken: token })
    });
    ids.push(...p.items.map(i => i.contentDetails.videoId));
    token = p.nextPageToken;
  } while (token);

  // 2. estadísticas y duración
  const videos = [];
  for (const lote of chunk(ids, 50)) {
    const v = await yt('videos', { part: 'snippet,statistics,contentDetails', id: lote.join(','), maxResults: 50 });
    videos.push(...v.items);
  }

  // 3. solo episodios largos, los clips fuera
  const episodios = videos
    .map(v => ({
      videoId: v.id,
      titulo: v.snippet.title,
      publicado: v.snippet.publishedAt,
      vistas: +v.statistics.viewCount || 0,
      likes: +v.statistics.likeCount || 0,
      comentarios: +v.statistics.commentCount || 0,
      ...isoADurac(v.contentDetails.duration)
    }))
    .filter(e => e.minutos >= CONFIG.duracionMinimaMin)
    .sort((a, b) => new Date(b.publicado) - new Date(a.publicado));

  if (!episodios.length) throw new Error('Ningún vídeo de la playlist supera la duración mínima.');

  const ultimo = episodios[0];
  const previos = episodios.slice(1, 1 + CONFIG.episodiosReferencia);
  const vistasPrevias = previos.map(e => e.vistas);

  // 4. comentarios con texto
  let comentarios = [];
  try {
    const c = await yt('commentThreads', {
      part: 'snippet', videoId: ultimo.videoId, order: 'relevance',
      maxResults: CONFIG.comentariosMostrados, textFormat: 'plainText'
    });
    comentarios = c.items.map(i => {
      const s = i.snippet.topLevelComment.snippet;
      return {
        autor: s.authorDisplayName,
        cuando: new Date(s.publishedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }),
        texto: s.textDisplay,
        likes: s.likeCount
      };
    });
  } catch { /* comentarios cerrados: el panel se oculta solo */ }

  const dias = Math.max(1, Math.round((Date.now() - new Date(ultimo.publicado)) / 864e5));

  return {
    canal: CONFIG.canalYouTube,
    episodio: {
      videoId: ultimo.videoId, titulo: ultimo.titulo,
      publicado: ultimo.publicado.slice(0, 10),
      vistas: ultimo.vistas, likes: ultimo.likes, comentarios: ultimo.comentarios,
      duracion: ultimo.texto, dias
    },
    referencia: {
      media: Math.round(vistasPrevias.reduce((a, b) => a + b, 0) / vistasPrevias.length),
      mediana: mediana(vistasPrevias),
      maximo: Math.max(...vistasPrevias, ultimo.vistas),
      episodios: episodios.length,
      criterio: 'vistas totales de los últimos ' + previos.length + ' episodios largos'
    },
    comentarios
  };
}

// ---------------------------------------------------------------------- main

const hoy = new Date();
const finSemana = new Date(hoy); finSemana.setDate(hoy.getDate() - hoy.getDay() || -7); // domingo pasado
const iniSemana = new Date(finSemana); iniSemana.setDate(finSemana.getDate() - 6);
const d = x => x.toISOString().slice(0, 10);

const fmtDia = x => x.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

const data = {
  semana: {
    etiqueta: `${fmtDia(iniSemana)} – ${fmtDia(finSemana)} de ${finSemana.getFullYear()}`,
    generado: hoy.toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: CONFIG.zona })
  },
  instagram: await instagram(d(iniSemana), d(finSemana)),
  youtube: await youtube()
};

await (await import('node:fs/promises')).writeFile('data.json', JSON.stringify(data, null, 2));
console.log(`OK · ${data.instagram.reels.length} reels · episodio "${data.youtube.episodio.titulo}"`);
