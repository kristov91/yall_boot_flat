// Minimal static file server for the Slice 0 test client. Serves this folder
// over HTTP on the LAN so phones/tablets can load index.html by URL.
//
// Usage: node dev_server.js [port]   (default port 8080)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] ? parseInt(process.argv[2], 10) : 8080;
const ROOT = __dirname;

// The Sub Editor exports rooms to ../layouts/ (a sibling of client/, shared
// with the Godot project) rather than into client/ itself, so a room export
// is never stale-copied for the client to see - serve that folder too, at
// the /layouts/ URL path the room renderer fetches from.
const LAYOUTS_ROOT = path.join(ROOT, '..', 'layouts');
// The spark/decal/particle sprites (weld spots, sparks, water drops, cracks)
// used by gameplay-spawned effects like the welder live under client/
// graphics/effects/ directly (a copy of the project-root graphics/effects/
// folder) - plain root-relative static serving below already reaches them,
// no special-cased route needed the way /layouts/ genuinely needs one.

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';

  const isLayoutsRequest = reqPath.startsWith('/layouts/');
  const base = isLayoutsRequest ? LAYOUTS_ROOT : ROOT;
  const relativePath = isLayoutsRequest ? reqPath.slice('/layouts/'.length) : reqPath;
  const filePath = path.join(base, relativePath);
  if (!filePath.startsWith(base)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Client server running on http://0.0.0.0:${PORT} (serving ${ROOT})`);
});
