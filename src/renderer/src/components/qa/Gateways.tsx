import { useState } from 'react'
import type { QaGateway } from '@shared/qa'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Field } from '@/components/ui/Field'
import { getApi, unwrap } from '@/lib/api'

export function Gateways({
  gateways,
  refresh,
}: {
  gateways: QaGateway[]
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(''),
    [server, setServer] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false)
  const action = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gateway action failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-2 text-lg font-semibold">Custom proxy gateways</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Connect another provider using its HTTP or SOCKS5 gateway. Credentials are encrypted by the OS keychain.
        Configure provider-specific location and session options in its username; location matrices apply only to
        profiles that use a built-in proxy provider.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void action(async () => {
            await unwrap(getApi().qa.saveGateway({ name, server, username, password }))
            setName('')
            setServer('')
            setUsername('')
            setPassword('')
          })
        }}
        className="flex flex-col gap-4"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field htmlFor="qa-gateway-name" label="Gateway name">
            <Input id="qa-gateway-name" required value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field htmlFor="qa-gateway-server" label="Server URL">
            <Input
              id="qa-gateway-server"
              required
              value={server}
              placeholder="http://proxy.example.com:8000"
              onChange={(event) => setServer(event.target.value)}
            />
          </Field>
          <Field htmlFor="qa-gateway-user" label="Username">
            <Input
              id="qa-gateway-user"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field htmlFor="qa-gateway-password" label="Password">
            <Input
              id="qa-gateway-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" className="self-start" disabled={busy}>
          Save gateway
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-col gap-2">
        {gateways.map((gateway) => (
          <div
            key={gateway.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3"
          >
            <div>
              <p className="text-sm font-semibold">{gateway.name}</p>
              <p className="text-xs text-muted-foreground">
                {gateway.server} · {gateway.exitIp ?? 'Not verified'}
                {gateway.latencyMs !== null ? ` · ${gateway.latencyMs} ms` : ''}
              </p>
              {gateway.lastError ? <p className="text-xs text-destructive">{gateway.lastError}</p> : null}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void action(async () => {
                    await unwrap(getApi().qa.testGateway(gateway.id))
                  })
                }}
              >
                Test connection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  void action(async () => {
                    await unwrap(getApi().qa.deleteGateway(gateway.id))
                  })
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
