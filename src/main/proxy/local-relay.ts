/**
 * Local authenticating proxy relay.
 *
 * Playwright's WebKit build on Linux cannot complete an HTTPS CONNECT tunnel
 * through a proxy that requires authentication (plain HTTP works, HTTPS fails
 * with "Connection terminated unexpectedly"). Chromium and Firefox are fine.
 *
 * The relay listens on 127.0.0.1 on a random port, accepts unauthenticated
 * proxy requests from the local browser process only, injects the
 * `Proxy-Authorization` header for the upstream provider gateway and forwards
 * the traffic. One relay is started per browser session, so each session keeps
 * its own sticky-session upstream username.
 *
 * Credentials never leave this process: the browser is given only
 * `http://127.0.0.1:<port>`.
 */
import http from 'node:http'
import net from 'node:net'
import type { Socket } from 'node:net'
import type { Logger, ProxyConnection } from '../contracts'
import { AppException } from '../contracts'

const SCOPE = 'proxy.relay'
const UPSTREAM_TIMEOUT_MS = 30_000

export interface ProxyRelay {
  /** Proxy server URL to hand to the browser, e.g. `http://127.0.0.1:38211`. */
  readonly server: string
  readonly port: number
  /** Number of live tunnelled / forwarded connections. */
  activeConnections(): number
  close(): Promise<void>
}

export interface UpstreamTarget {
  host: string
  port: number
}

/** Parse `http://host:port` (or bare `host:port`) into host + port. */
export function parseUpstream(server: string): UpstreamTarget {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(server) ? server : `http://${server}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new AppException('PROXY_DEAD', 'The proxy server address is invalid.', `Unparseable proxy server: ${server}`)
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppException('PROXY_DEAD', 'The proxy server address is invalid.', `Unparseable proxy server: ${server}`)
  }
  return { host: url.hostname, port }
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

/** Parse the status line of an upstream CONNECT response. Returns null until the header block is complete. */
export function parseConnectResponse(buffer: Buffer): { status: number; headerEnd: number } | null {
  const idx = buffer.indexOf('\r\n\r\n')
  if (idx === -1) return null
  const statusLine = buffer.subarray(0, idx).toString('latin1').split('\r\n')[0] ?? ''
  const status = Number(statusLine.split(' ')[1])
  return { status: Number.isFinite(status) ? status : 0, headerEnd: idx + 4 }
}

function describeTarget(url: string | undefined): string {
  return url ? url.replace(/^[^:]+:\/\/[^@]*@/, '') : '<unknown>'
}

/**
 * Start a relay in front of `upstream`. Resolves once the socket is listening.
 */
export function startProxyRelay(upstream: ProxyConnection, logger: Logger): Promise<ProxyRelay> {
  const target = parseUpstream(upstream.server)
  const authorization = basicAuthHeader(upstream.username, upstream.password)
  const sockets = new Set<Socket>()
  let closed = false

  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }

  const server = http.createServer((req, res) => {
    // Plain HTTP proxy request: the client sends an absolute-form URL.
    if (!req.url || !/^https?:\/\//i.test(req.url)) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('Proxy relay only accepts absolute-form proxy requests.')
      return
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, 'proxy-authorization': authorization }
    delete headers['proxy-connection']
    const forwarded = http.request(
      { host: target.host, port: target.port, method: req.method, path: req.url, headers, timeout: UPSTREAM_TIMEOUT_MS },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    forwarded.on('timeout', () => forwarded.destroy(new Error('upstream proxy timed out')))
    forwarded.on('error', (err) => {
      logger.warn(SCOPE, `Upstream proxy request failed for ${describeTarget(req.url)}`, { error: err.message })
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('Upstream proxy request failed.')
    })
    req.pipe(forwarded)
    if (req.socket) track(req.socket)
  })

  server.on('connect', (req, clientSocket: Socket, head: Buffer) => {
    const hostPort = req.url ?? ''
    track(clientSocket)
    const upstreamSocket = net.connect({ host: target.host, port: target.port })
    upstreamSocket.setTimeout(UPSTREAM_TIMEOUT_MS)
    track(upstreamSocket)
    let buffer = Buffer.alloc(0)

    const fail = (status: number, reason: string, err?: Error): void => {
      logger.warn(SCOPE, `CONNECT ${hostPort} failed: ${reason}`, err ? { error: err.message } : undefined)
      if (clientSocket.writable) clientSocket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
      upstreamSocket.destroy()
    }

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const parsed = parseConnectResponse(buffer)
      if (!parsed) return
      upstreamSocket.off('data', onData)
      if (parsed.status !== 200) {
        fail(parsed.status === 407 ? 407 : 502, parsed.status === 407 ? 'Proxy Authentication Required' : `Upstream proxy returned ${parsed.status}`)
        return
      }
      upstreamSocket.setTimeout(0)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const remainder = buffer.subarray(parsed.headerEnd)
      if (remainder.length > 0) clientSocket.write(remainder)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    }

    upstreamSocket.once('connect', () => {
      upstreamSocket.write(
        `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nProxy-Authorization: ${authorization}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      )
      upstreamSocket.on('data', onData)
    })
    upstreamSocket.once('timeout', () => fail(504, 'Upstream proxy timed out'))
    upstreamSocket.once('error', (err) => fail(502, 'Upstream proxy connection failed', err))
    clientSocket.once('error', () => upstreamSocket.destroy())
    clientSocket.once('close', () => upstreamSocket.destroy())
    upstreamSocket.once('close', () => clientSocket.destroy())
  })

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  return new Promise<ProxyRelay>((resolve, reject) => {
    server.once('error', (err) => {
      reject(new AppException('INTERNAL', 'Could not start the local proxy relay for WebKit.', err.message))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new AppException('INTERNAL', 'Could not determine the local proxy relay port.'))
        return
      }
      const port = address.port
      logger.info(SCOPE, `Local proxy relay listening on 127.0.0.1:${port} → ${target.host}:${target.port}`, {
        sessionId: upstream.sessionId,
      })
      resolve({
        server: `http://127.0.0.1:${port}`,
        port,
        activeConnections: () => sockets.size,
        close: () =>
          new Promise<void>((done) => {
            if (closed) {
              done()
              return
            }
            closed = true
            for (const socket of sockets) socket.destroy()
            server.close(() => {
              logger.info(SCOPE, `Local proxy relay on 127.0.0.1:${port} closed`)
              done()
            })
          }),
      })
    })
  })
}
