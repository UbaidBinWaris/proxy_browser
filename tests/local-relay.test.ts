import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger, ProxyConnection } from '../src/main/contracts'
import { basicAuthHeader, parseConnectResponse, parseUpstream, startProxyRelay } from '../src/main/proxy/local-relay'
import type { ProxyRelay } from '../src/main/proxy/local-relay'

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
  onEntry: () => () => undefined,
  query: () => [],
  clear: () => undefined,
  registerSecret: () => undefined,
}

/** A fake upstream proxy that records the Proxy-Authorization it receives. */
function startFakeUpstream(): Promise<{
  port: number
  seenAuth: string[]
  close: () => Promise<void>
  originPort: number
}> {
  const seenAuth: string[] = []
  // Origin server the CONNECT tunnel will reach.
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('origin-ok')
  })
  const upstream = http.createServer((req, res) => {
    seenAuth.push(String(req.headers['proxy-authorization'] ?? ''))
    if (!req.headers['proxy-authorization']) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake"' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-forwarded-path': req.url ?? '' })
    res.end('plain-ok')
  })
  upstream.on('connect', (req, socket, head) => {
    seenAuth.push(String(req.headers['proxy-authorization'] ?? ''))
    if (!req.headers['proxy-authorization']) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    const [host, portText] = (req.url ?? '').split(':')
    const target = net.connect(Number(portText), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      target.pipe(socket)
      socket.pipe(target)
    })
    target.on('error', () => socket.destroy())
  })
  return new Promise((resolve) => {
    origin.listen(0, '127.0.0.1', () => {
      upstream.listen(0, '127.0.0.1', () => {
        const port = (upstream.address() as net.AddressInfo).port
        const originPort = (origin.address() as net.AddressInfo).port
        resolve({
          port,
          originPort,
          seenAuth,
          close: () =>
            new Promise((done) => {
              upstream.close(() => origin.close(() => done()))
            }),
        })
      })
    })
  })
}

/** Issue a CONNECT through the relay and then a raw HTTP GET inside the tunnel. */
function connectThroughRelay(relayPort: number, target: string): Promise<{ connectStatus: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relayPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let buffer = Buffer.alloc(0)
    let connectStatus = 0
    let tunnelled = false
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!tunnelled) {
        const parsed = parseConnectResponse(buffer)
        if (!parsed) return
        connectStatus = parsed.status
        buffer = buffer.subarray(parsed.headerEnd)
        tunnelled = true
        if (connectStatus !== 200) {
          socket.end()
          resolve({ connectStatus, body: '' })
          return
        }
        socket.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`)
        return
      }
    })
    socket.on('end', () => resolve({ connectStatus, body: buffer.toString() }))
    socket.on('error', reject)
  })
}

describe('local proxy relay', () => {
  let relay: ProxyRelay | null = null
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>> | null = null

  afterEach(async () => {
    await relay?.close()
    await upstream?.close()
    relay = null
    upstream = null
  })

  it('parses upstream server strings', () => {
    expect(parseUpstream('http://gw.example.com:823')).toEqual({ host: 'gw.example.com', port: 823 })
    expect(parseUpstream('gw.example.com:8080')).toEqual({ host: 'gw.example.com', port: 8080 })
    expect(parseUpstream('http://gw.example.com')).toEqual({ host: 'gw.example.com', port: 80 })
    expect(() => parseUpstream('http://:0')).toThrow()
  })

  it('builds a Basic auth header', () => {
    expect(basicAuthHeader('user__sessid.abc', 'p@ss')).toBe(`Basic ${Buffer.from('user__sessid.abc:p@ss').toString('base64')}`)
  })

  it('parses CONNECT responses incrementally', () => {
    expect(parseConnectResponse(Buffer.from('HTTP/1.1 200 Connection'))).toBeNull()
    expect(parseConnectResponse(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\nrest'))).toEqual({ status: 200, headerEnd: 39 })
    expect(parseConnectResponse(Buffer.from('HTTP/1.1 407 Nope\r\nProxy-Authenticate: Basic\r\n\r\n'))?.status).toBe(407)
  })

  it('injects Proxy-Authorization on CONNECT tunnels and relays the tunnelled bytes', async () => {
    upstream = await startFakeUpstream()
    const connection: ProxyConnection = {
      server: `http://127.0.0.1:${upstream.port}`,
      username: 'alice__sessid.s1',
      password: 'secret',
      pool: 'residential',
      sessionId: 's1',
      target: null,
      targetingString: 'sessid.s1',
    }
    relay = await startProxyRelay(connection, noopLogger)
    expect(relay.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const result = await connectThroughRelay(relay.port, `127.0.0.1:${upstream.originPort}`)
    expect(result.connectStatus).toBe(200)
    expect(result.body).toContain('origin-ok')
    expect(upstream.seenAuth).toEqual([basicAuthHeader('alice__sessid.s1', 'secret')])
  })

  it('injects Proxy-Authorization on plain HTTP proxy requests', async () => {
    upstream = await startFakeUpstream()
    const connection: ProxyConnection = { server: `127.0.0.1:${upstream.port}`, username: 'bob', password: 'pw', pool: 'residential', sessionId: null, target: null, targetingString: '' }
    relay = await startProxyRelay(connection, noopLogger)

    const response = await new Promise<{ status: number; body: string; path: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: relay!.port, method: 'GET', path: 'http://origin.test/hello' }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, path: String(res.headers['x-forwarded-path']) }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(response.status).toBe(200)
    expect(response.body).toBe('plain-ok')
    expect(response.path).toBe('http://origin.test/hello')
    expect(upstream.seenAuth).toEqual([basicAuthHeader('bob', 'pw')])
  })

  it('rejects non-proxy requests and reports upstream failures as 502', async () => {
    relay = await startProxyRelay({ server: 'http://127.0.0.1:1', username: 'u', password: 'p', pool: 'residential', sessionId: null, target: null, targetingString: '' }, noopLogger)
    const bad = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: relay!.port, method: 'GET', path: '/relative' }, (res) => resolve(res.statusCode ?? 0))
      req.on('error', reject)
      req.end()
    })
    expect(bad).toBe(400)
    const dead = await connectThroughRelay(relay.port, 'example.com:443')
    expect(dead.connectStatus).toBe(502)
  })

  it('close() terminates the listener', async () => {
    relay = await startProxyRelay({ server: 'http://127.0.0.1:1', username: 'u', password: 'p', pool: 'residential', sessionId: null, target: null, targetingString: '' }, noopLogger)
    const port = relay.port
    await relay.close()
    relay = null
    await expect(
      new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => resolve('connected'))
        s.on('error', reject)
      }),
    ).rejects.toBeTruthy()
  })
})
