// Placeholder server for the Docker stack (prompt 01).
// Replaced by the real backend core in prompt 02.
import { createServer } from 'node:http';

const PORT = 3202;

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'app', placeholder: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`app placeholder listening on ${PORT}`);
});
