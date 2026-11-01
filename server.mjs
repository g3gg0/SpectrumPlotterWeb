import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {firmwareRequest} from './firmware-api.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8080);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if(url.pathname.startsWith('/api/firmware/')){
      if(request.method!=='GET'){response.writeHead(405).end('Method not allowed');return;}
      try{
        const result=await firmwareRequest(url);
        if(!result){response.writeHead(404).end('Unknown firmware endpoint');return;}
        response.writeHead(200,{'Content-Type':result.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(result.body);
      }catch(error){
        console.error('Firmware API:',error.message);
        response.writeHead(502,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({error:error.message}));
      }
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root) || !['.html','.js','.css','.svg','.json'].includes(path.extname(file))) {
      response.writeHead(403).end('Forbidden'); return;
    }
    const content = await readFile(file);
    response.writeHead(200, {'Content-Type':types[path.extname(file)], 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff'}).end(content);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`SpectrumPlotterWeb: http://localhost:${port}`));
