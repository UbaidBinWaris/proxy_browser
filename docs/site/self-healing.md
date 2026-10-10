# Self-healing selectors

[Recorded steps](/use-cases/test-recorder) keep backup locators, so a scenario keeps running when a page's `id` or class changes, flags the healed step and lets you update the scenario in one click.

## Why it exists

Pages change. An `id` gets renamed and a recorded `#submit-btn` stops matching. Without fallbacks the step fails and someone has to find the new selector by hand. Self-healing tries a small set of more stable locators for the same element, and reports what it did so that the change is reviewed rather than hidden. The same idea is also called self-healing locators.

## Fallbacks

When the recorder captures a `click`, `fill`, `select`, `check`, `uncheck` or `upload` step, it also stores up to **four fallbacks** for that element, most stable first:

| Fallback | Example |
| --- | --- |
| Test ID | `data-testid`, `data-test` or `data-qa` attribute |
| Role and accessible name | A button named "Submit" |
| Label text | The `<label>` associated with a field |
| Placeholder | A field's `placeholder` |
| Visible text | Short text of a button or link |
| CSS path | A structural CSS selector |

Fallbacks never contain field values. Password fields and `data-qa-sensitive` elements are not recorded at all. The editor shows how many fallbacks each step has. For a step inside a frame, the fallbacks are looked up inside that frame.

Scenarios saved before this feature have no fallbacks and behave as before.

## How healing works during a run

1. The primary selector is tried first.
2. Only when it matches **no element at all** does the runner try the fallbacks in order.
3. A fallback is accepted only when it matches **exactly one** element (and, for a role fallback, an element with that role).

Rules that keep healing honest:

- An element that exists but is hidden or disabled is a real failure and never heals.
- The primary selector and the fallbacks share the step timeout: the primary gets the first 60% to appear, the fallbacks the rest, so healing never makes a step longer.
- **Assertions, checks and navigation never heal.** Healing an expected-result check could hide a real bug.

## Modes

Choose the behaviour with **Self-healing** in the scenario editor:

| Mode | Behaviour |
| --- | --- |
| **Off** | Fallbacks are ignored; a selector that matches nothing fails the step |
| **Warn** (default) | The step runs on the fallback and passes; the case is flagged **Healed** in Results and reports |
| **Fail** | The step fails without acting, and the message names the suggested replacement selector |

## Review and update a scenario

In **Results**, a healed step shows a **Healed** badge (or **Healing blocked** in fail mode) with the original and the suggested selector.

1. Review the step's screenshot to confirm the right element was used.
2. Click **Update selector in scenario**.

The suggested selector becomes the step's primary selector, and the old one is kept as its first CSS fallback. The update uses the saved scenario's own fallback and is refused if the scenario changed since that run.

Suggested selectors for roles, labels and text use Playwright's exact `internal:role`, `internal:label` and `internal:text` selectors; test IDs and placeholders use plain CSS.

## In reports and CI

- **JSON** reports include each healed step's original selector, the fallback used and the suggested selector, plus the batch's `healedSteps` count.
- **JUnit** adds a `healed` property and a `system-out` line per healed step.
- **HTML** shows a **Healed** badge.

The [CI runner](/docs/ci-runner) accepts `--healing off|warn|fail` to override every scenario in a manifest; without it, each scenario's own mode applies (warn when unset). `--healing fail` is useful in CI when any healed selector should block a merge until the scenario is updated:

```bash
npm run qa -- --config scenario.json --healing fail --output qa-results
```

The GitHub Action exposes the same option as the `healing` input, and the [MCP server](/docs/mcp-server) as the `healing` argument of `run_check` and `run_manifest`.
