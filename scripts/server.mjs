import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../dist/web/', import.meta.url));
const contentTypes = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export function serve(port = 4173) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.resolve(directory, name);
    if (path.relative(directory, full).startsWith('..') || path.isAbsolute(path.relative(directory, full))) { res.writeHead(403).end(); return; }
    try {
      const content = await readFile(full);
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(content);
    } catch { res.writeHead(404).end('Not found'); }
  }).listen(port, '127.0.0.1');
}
