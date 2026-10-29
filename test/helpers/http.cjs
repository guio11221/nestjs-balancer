'use strict';

/**
 * Helpers compartilhados pelos testes de integração.
 *
 * Regras importantes:
 * - sempre usar porta 0 e 127.0.0.1 para evitar colisão entre arquivos;
 * - registrar o cleanup em um único `t.after`, destruindo o service antes dos servidores;
 * - fechar conexões keep-alive antes de aguardar `server.close()`.
 */

const http = require('node:http');
const { RouteBalancerService, RouteBalancerMiddleware } = require('../../dist/index.js');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

/**
 * Cria o gateway HTTP/1 usando Exatamente o mesmo middleware público do pacote.
 */
function createGateway(options) {
  const service = new RouteBalancerService(options);
  const middleware = new RouteBalancerMiddleware(service);
  const server = http.createServer((request, response) => {
    middleware.use(request, response, () => {
      response.writeHead(404).end('not found');
    });
  });

  return { server, service };
}

/**
 * Cleanup determinístico: encerra o service, derruba sockets keep-alive e só
 * então fecha os servidores HTTP.
 */
function registerCleanup(t, { service, servers = [] }) {
  const unique = [...new Set(servers.filter(Boolean))];

  t.after(async () => {
    service?.onModuleDestroy();
    for (const server of unique) server.closeAllConnections?.();
    await Promise.all(unique.map(server => close(server)));
  });
}

/**
 * Upstream de teste que devolve um JSON identificável. Útil para provar qual
 * instância atendeu a requisição e qual path/body chegou nela.
 */
function createJsonUpstream(id) {
  return http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200).end('ok');
      return;
    }

    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.once('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        id,
        path: request.url,
        body,
        method: request.method,
      }));
    });
  });
}

function createTextUpstream(text, statusCode = 200) {
  return http.createServer((_request, response) => {
    response.writeHead(statusCode, { 'content-type': 'text/plain' });
    response.end(text);
  });
}

/**
 * `response.headers.getSetCookie()` não existe em runtimes antigos; este helper
 * mantém os testes compatíveis e evita repetir o fallback em cada fluxo.
 */
function getSetCookies(response) {
  const values = response.headers.getSetCookie?.();
  if (values?.length) return values;

  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * `fetch` normaliza/omite alguns headers proibidos, então o fluxo de Host usa
 * `node:http` diretamente.
 */
function requestRaw(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(baseUrl);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path,
        method,
        headers,
      },
      response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          data += chunk;
        });
        response.once('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: data,
          });
        });
      },
    );

    request.once('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  close,
  createGateway,
  createJsonUpstream,
  createTextUpstream,
  getSetCookies,
  listen,
  registerCleanup,
  requestRaw,
  sleep,
};
