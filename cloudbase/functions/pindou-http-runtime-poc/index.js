const http = require('node:http');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 9000);
http.createServer((req, res) => {
  if (req.url === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cloudbase-runtime-probe' }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, host);
