const http = require("node:http");
for (const port of [3001, 3002]) {
  http
    .createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () =>
        res.end(
          JSON.stringify({
            instance: port,
            path: req.url,
            method: req.method,
            body,
          }),
        ),
      );
    })
    .listen(port, () => console.log(`upstream ${port}`));
}
