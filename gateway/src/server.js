// Placeholder server for the Docker stack (prompt 01).
// The Rapyd adapter is added in prompt 06.
import { createServer } from 'node:http';

const PORT = 3203;

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'gateway', placeholder: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`gateway placeholder listening on ${PORT}`);
});
