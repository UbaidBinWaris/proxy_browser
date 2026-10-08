import { useState } from 'react'
import { EnvironmentInputSchema, SuiteInputSchema } from '@shared/qa'
import type { QaSnapshot, QaSuite } from '@shared/qa'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Field } from '@/components/ui/Field'
import { getApi, unwrap } from '@/lib/api'

export function SuitesEnvironments({
  snapshot,
  workspaceId,
  busy,
  perform,
  onRun,
}: {
  snapshot: QaSnapshot
  workspaceId: string
  busy: boolean
  perform: (fn: () => Promise<void>) => Promise<void>
  onRun: (suite: QaSuite) => void
}): React.JSX.Element {
  const [envId, setEnvId] = useState<string | undefined>()
  const [envName, setEnvName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [variables, setVariables] = useState('{}')
  const [suiteId, setSuiteId] = useState<string | undefined>()
  const [suiteName, setSuiteName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const scenarios = snapshot.scenarios.filter((item) => item.workspaceId === workspaceId)
  const clearEnv = (): void => {
    setEnvId(undefined)
    setEnvName('')
    setBaseUrl('')
    setVariables('{}')
  }
  const clearSuite = (): void => {
    setSuiteId(undefined)
    setSuiteName('')
    setSelected([])
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">Environments</h2>
        <p className="text-sm text-muted-foreground">
          Choose a base origin for development, staging or production. Paths stay the same.
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void perform(async () => {
              await unwrap(
                getApi().qa.saveEnvironment(
                  EnvironmentInputSchema.parse({
                    workspaceId,
                    name: envName,
                    baseUrl,
                    variables: JSON.parse(variables),
                  }),
                  envId,
                ),
              )
              clearEnv()
            })
          }}
        >
          <Field htmlFor="qa-env-name" label="Environment name">
            <Input
              id="qa-env-name"
              required
              maxLength={120}
              value={envName}
              onChange={(event) => setEnvName(event.target.value)}
            />
          </Field>
          <Field htmlFor="qa-env-url" label="Environment base origin">
            <Input
              id="qa-env-url"
              type="url"
              required
              placeholder="https://staging.example.com"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Field htmlFor="qa-env-vars" label="Environment variables (JSON)">
            <Textarea
              id="qa-env-vars"
              rows={3}
              value={variables}
              onChange={(event) => setVariables(event.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Save environment
            </Button>
            {envId ? (
              <Button variant="ghost" onClick={clearEnv}>
                Cancel edit
              </Button>
            ) : null}
          </div>
        </form>
        {snapshot.environments
          .filter((item) => item.workspaceId === workspaceId)
          .map((env) => (
            <article
              key={env.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"
            >
              <div>
                <h3 className="font-semibold">{env.name}</h3>
                <p className="text-xs text-muted-foreground">{env.baseUrl}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEnvId(env.id)
                    setEnvName(env.name)
                    setBaseUrl(env.baseUrl)
                    setVariables(JSON.stringify(env.variables, null, 2))
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      await unwrap(getApi().qa.deleteEnvironment(env.id))
                      if (envId === env.id) clearEnv()
                    })
                  }}
                >
                  Delete
                </Button>
              </div>
            </article>
          ))}
      </section>
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">Test suites</h2>
        <p className="text-sm text-muted-foreground">
          Group scenarios into one run. Every scenario keeps its own profile and datasets; run limits cover the complete
          suite.
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void perform(async () => {
              await unwrap(
                getApi().qa.saveSuite(
                  SuiteInputSchema.parse({ workspaceId, name: suiteName, scenarioIds: selected }),
                  suiteId,
                ),
              )
              clearSuite()
            })
          }}
        >
          <Field htmlFor="qa-suite-name" label="Suite name">
            <Input
              id="qa-suite-name"
              required
              value={suiteName}
              maxLength={120}
              onChange={(event) => setSuiteName(event.target.value)}
            />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Included scenarios</legend>
            <div className="flex flex-col gap-2">
              {scenarios.map((scenario) => (
                <label key={scenario.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(scenario.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked ? [...current, scenario.id] : current.filter((id) => id !== scenario.id),
                      )
                    }
                  />
                  {scenario.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !selected.length}>
              Save suite
            </Button>
            {suiteId ? (
              <Button variant="ghost" onClick={clearSuite}>
                Cancel edit
              </Button>
            ) : null}
          </div>
        </form>
        {snapshot.suites
          .filter((item) => item.workspaceId === workspaceId)
          .map((suite) => (
            <article key={suite.id} className="flex flex-col gap-2 border-t border-border pt-3">
              <div>
                <h3 className="font-semibold">{suite.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {suite.scenarioIds.length} {suite.scenarioIds.length === 1 ? 'scenario' : 'scenarios'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => onRun(suite)}>
                  Run suite
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setSuiteId(suite.id)
                    setSuiteName(suite.name)
                    setSelected(suite.scenarioIds)
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      const path = await unwrap(getApi().qa.exportSuite(suite.id))
                      await unwrap(getApi().app.openPath(path))
                    })
                  }}
                >
                  Export suite for CI
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      await unwrap(getApi().qa.deleteSuite(suite.id))
                      if (suiteId === suite.id) clearSuite()
                    })
                  }}
                >
                  Delete
                </Button>
              </div>
            </article>
          ))}
      </section>
    </div>
  )
}
