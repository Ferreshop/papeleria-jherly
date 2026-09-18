// Papelería Jherly - backend PDF sin pdfjs-dist
// Cuenta páginas de PDF sin renderizarlas.
// Las instrucciones del cliente (B/N/color por página) se aplican en el index.html.

export const config = { api: { bodyParser: false } };

async function readBody(req, max = 15 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) throw new Error('Archivo demasiado grande (máximo 15 MB).');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractMultipartFile(body, contentType) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw new Error('Solicitud multipart inválida.');
  const boundary = '--' + (m[1] || m[2]).trim();
  const binary = body.toString('binary');
  const parts = binary.split(boundary);

  for (const part of parts) {
    if (!/content-disposition:\s*form-data/i.test(part) || !/filename=/i.test(part)) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    let payload = part.slice(headerEnd + 4);
    payload = payload.replace(/\r\n--$/, '').replace(/\r\n$/, '');
    return Buffer.from(payload, 'binary');
  }
  throw new Error('No se encontró el archivo PDF.');
}

function countPdfPages(pdf) {
  // Para PDFs normales, cada página tiene un objeto /Type /Page.
  // Evitamos contar /Type /Pages (árbol de páginas).
  const latin = pdf.toString('latin1');
  const matches = latin.match(/\/Type\s*\/Page(?!s)\b/g);
  if (matches && matches.length) return matches.length;

  // Respaldo: algunos PDFs guardan el total en /Count dentro del árbol /Pages.
  const counts = [...latin.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,500}?\/Count\s+(\d+)/g)]
    .map(x => Number(x[1]))
    .filter(n => Number.isInteger(n) && n > 0 && n <= 5000);
  if (counts.length) return Math.max(...counts);

  throw new Error('No pude determinar el número de páginas de este PDF.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });

  try {
    const body = await readBody(req);
    const contentType = req.headers['content-type'] || '';
    const pdf = contentType.includes('multipart/form-data')
      ? extractMultipartFile(body, contentType)
      : body;

    if (pdf.length < 5 || pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('El archivo no parece ser un PDF válido.');
    }

    const numPages = countPdfPages(pdf);
    if (numPages > 150) throw new Error('Máximo 150 páginas por análisis.');

    // Sin renderizar páginas no inventamos si son B/N o color.
    // Se devuelve una base B/N y el frontend aplica las instrucciones del cliente.
    const details = Array.from({ length: numPages }, (_, i) => ({
      page: i + 1,
      type: 'bn',
      colorRatio: null,
      inkRatio: null
    }));

    return res.status(200).json({
      pages: numPages,
      counts: { bn: numPages, school: 0, full: 0 },
      details,
      method: 'page-count-customer-instructions-v1',
      automaticColorDetection: false
    });
  } catch (error) {
    console.error('analyze-pdf:', error);
    return res.status(400).json({
      error: error?.message || 'No se pudo analizar el PDF.'
    });
  }
}
