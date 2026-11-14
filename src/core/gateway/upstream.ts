import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

export interface OpenOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  proxy?: string;
  timeoutMs?: number;
  firstByteTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface OpenResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: NodeJS.ReadableStream;
  raw: http.IncomingMessage;
}

/** HTTP/HTTPS transport, with explicit HTTP(S) proxy support and bounded idle timeouts. */
export function openUpstream(urlStr: string, opt: OpenOptions = {}): Promise<OpenResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    let proxyUrl: URL | undefined;
    try {
      url = new URL(urlStr);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid upstream URL: HTTP/HTTPS without credentials required');
      if (opt.proxy) {
        proxyUrl = new URL(opt.proxy);
        if (!['http:', 'https:'].includes(proxyUrl.protocol)) throw new Error('Only HTTP/HTTPS proxies are supported');
      }
    } catch (error) { reject(error); return; }
    if (opt.signal?.aborted) { reject(new Error('Request cancelled')); return; }
    const timeout = Math.max(1000, opt.timeoutMs ?? 600000);
    const firstTimeout = Math.max(1000, Math.min(timeout, opt.firstByteTimeoutMs ?? timeout));
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port || (isHttps ? 443 : 80));
    const method = opt.method ?? 'POST';
    const headers: Record<string, string> = { host: url.host, ...opt.headers };
    if (opt.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opt.body));
    const proxyAuth = proxyUrl?.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64') : undefined;
    let active: http.ClientRequest | undefined;
    let tunnelAgent: https.Agent | undefined;
    const abort = () => { active?.destroy(new Error('Request cancelled')); tunnelAgent?.destroy(); };
    opt.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => opt.signal?.removeEventListener('abort', abort);
    const fail = (error: Error) => { cleanup(); tunnelAgent?.destroy(); reject(error); };
    const onResponse = (res: http.IncomingMessage) => {
      active?.setTimeout(timeout);
      res.once('close', () => { cleanup(); tunnelAgent?.destroy(); });
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res, raw: res });
    };
    const send = (req: http.ClientRequest, body = opt.body) => {
      active = req;
      req.once('error', fail);
      req.setTimeout(firstTimeout, () => req.destroy(new Error('Upstream request timed out')));
      if (body !== undefined) req.write(body);
      req.end();
    };
    const makeRequest = (agent?: https.Agent) => {
      send((isHttps ? https : http).request({ protocol: url.protocol, hostname: url.hostname, port,
        path: url.pathname + url.search, method, headers, agent }, onResponse));
    };
    if (!proxyUrl) { makeRequest(); return; }
    const proxyTransport = proxyUrl.protocol === 'https:' ? https : http;
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
    if (!isHttps) {
      send(proxyTransport.request({ hostname: proxyUrl.hostname, port: proxyPort, method, path: url.href,
        headers: { ...headers, ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}) } }, onResponse));
      return;
    }
    const connectReq = proxyTransport.request({ hostname: proxyUrl.hostname, port: proxyPort, method: 'CONNECT',
      path: `${url.hostname}:${port}`, headers: { host: `${url.hostname}:${port}`, ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}) } });
    active = connectReq;
    connectReq.setTimeout(firstTimeout, () => connectReq.destroy(new Error('Proxy connection timed out')));
    connectReq.once('error', fail);
    connectReq.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); fail(new Error(`Proxy CONNECT failed: ${res.statusCode}`)); return; }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: net.isIP(url.hostname) ? undefined : url.hostname });
      secure.once('error', fail);
      tunnelAgent = new https.Agent({ keepAlive: false });
      tunnelAgent.createConnection = (() => secure) as typeof tunnelAgent.createConnection;
      makeRequest(tunnelAgent);
    });
    connectReq.end();
  });
}

export async function readAll(stream: NodeJS.ReadableStream, limit = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += c.length;
      if (size > limit) {
        (stream as any).destroy?.();
        chunks.length = 0;
        reject(new Error('响应体过大'));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
    stream.on('aborted', () => reject(new Error('Response stream aborted')));
  });
}
