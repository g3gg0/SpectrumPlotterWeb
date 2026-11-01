import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8080);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root) || !['.html','.js','.css','.svg','.json'].includes(path.extname(file))) {
      response.writeHead(403).end('Forbidden'); return;
    }
    const content = await readFile(file);
    response.writeHead(200, {'Content-Type':types[path.extname(file)], 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff'}).end(content);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`SpectrumPlotterWeb: http://localhost:${port}`));
