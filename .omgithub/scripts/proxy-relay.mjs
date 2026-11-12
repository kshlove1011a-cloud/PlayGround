// Local CONNECT relay to an authenticated upstream HTTP proxy (DataImpulse).
// OpenCode only ever sees http://127.0.0.1:PORT, so the upstream login and
// password never reach its env, its logs or opencode.log. Counts tunneled
// bytes for cost tracking (totals plus bytes per target hostname; never credentials).
// maxBytes (PROXY_RELAY_MAX_BYTES, default 150 MB) refuses new tunnels once a run
// has moved that much traffic, so a looping agent cannot burn the metered plan.
//
// Usage: node proxy-relay.mjs <creds-file> <port-file> <bytes-file>
// creds-file: JSON {host, port, user, password}; read once, then deleted.
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

export const DEFAULT_MAX_BYTES = 150 * 1024 * 1024
export function createRelay({ host, port, user, password, connectUpstream = connect, onFailure = () => {}, maxBytes = DEFAULT_MAX_BYTES }) {
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
  const totals = { up: 0, down: 0, tunnels: 0, failed: 0, last_error: '', capped: 0, hosts: {} }
  const count = (name, n) => { if (name in totals.hosts || Object.keys(totals.hosts).length < 50) totals.hosts[name] = (totals.hosts[name] || 0) + n }
  const server = createServer((req, res) => { res.writeHead(405, { connection: 'close' }); res.end() })
  server.on('connect', (req, client, head) => {
    const target = String(req.url || '')
    if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(target)) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    if (maxBytes > 0 && totals.up + totals.down >= maxBytes) { totals.capped++; totals.last_error = 'byte cap reached'; client.end('HTTP/1.1 503 Proxy Byte Cap Reached\r\n\r\n'); onFailure(); return }
    const hostname = target.replace(/:\d+$/, '').toLowerCase()
    const upstream = connectUpstream({ host, port })
    let buffered = Buffer.alloc(0), open = false
    const fail = () => { totals.failed++; if (!open) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); else client.destroy(); upstream.destroy() }
    upstream.setTimeout(30000, () => { if (!open) fail() })
    upstream.on('error', fail)
    client.on('error', () => upstream.destroy())
    upstream.on('connect', () => upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`))
    const onHeader = chunk => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) { if (buffered.length > 16384) fail(); return }
      upstream.off('data', onHeader)
      const line = /^HTTP\/1\.[01] (\d{3}) ?([^\r\n]*)/.exec(buffered.subarray(0, end).toString('latin1'))
      const status = Number(line?.[1])
      if (status !== 200) {
        // Keep the upstream reason (e.g. 407 TRAFFIC_EXHAUSTED) visible; never echo credentials or headers.
        const reason = String(line?.[2] || '').replace(/[^A-Za-z0-9_ -]/g, '').trim().slice(0, 40)
        totals.failed++; totals.last_error = `${status || 'bad'}${reason ? ' ' + reason : ''}`
        client.end(`HTTP/1.1 ${status === 407 || !status ? 502 : status} Upstream Proxy Error (${totals.last_error})\r\n\r\n`); upstream.destroy(); onFailure(); return
      }
      open = true; totals.tunnels++; upstream.setTimeout(0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const rest = buffered.subarray(end + 4)
      if (rest.length) { totals.down += rest.length; count(hostname, rest.length); client.write(rest) }
      if (head?.length) { totals.up += head.length; count(hostname, head.length); upstream.write(head) }
      upstream.on('data', data => { totals.down += data.length; count(hostname, data.length) })
      client.on('data', data => { totals.up += data.length; count(hostname, data.length) })
      upstream.pipe(client); client.pipe(upstream)
    }
    upstream.on('data', onHeader)
  })
  return { server, totals }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [credsFile, portFile, bytesFile] = process.argv.slice(2)
  const creds = JSON.parse(readFileSync(credsFile, 'utf8'))
  rmSync(credsFile, { force: true })
  let save = () => {}
  const cap = Number(process.env.PROXY_RELAY_MAX_BYTES)
  const { server, totals } = createRelay({ ...creds, onFailure: () => save(), maxBytes: Number.isFinite(cap) && process.env.PROXY_RELAY_MAX_BYTES ? cap : DEFAULT_MAX_BYTES })
  save = () => { try { writeFileSync(bytesFile, JSON.stringify({ up: totals.up, down: totals.down, tunnels: totals.tunnels, failed: totals.failed, last_error: totals.last_error, capped: totals.capped, hosts: totals.hosts })) } catch {} }
  setInterval(save, 15000).unref()
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { save(); process.exit(0) })
  server.listen(0, '127.0.0.1', () => { writeFileSync(portFile, String(server.address().port)); save() })
}
