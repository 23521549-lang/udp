const http = require("node:http");

http
  .createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404);
    res.end(req.url === "/healthz" ? "ok" : "");
  })
  .listen(Number(process.env.PORT ?? 8080));
