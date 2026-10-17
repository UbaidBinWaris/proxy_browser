# Decodo proxy setup

To test your own site through a Decodo (formerly Smartproxy) residential plan, save the plan's proxy username and password in Proxy QA Browser, pick a US state, city or ZIP code on the Launch page, and the app builds the Decodo username parameters, checks the exit IP's location and opens the browser. Decodo support is **community-verified**: written from Decodo's parameter documentation and not tested with a live account. Proxy QA Browser does not sell proxies and is [not affiliated with or endorsed by Decodo](/docs/introduction#license).

## What you need

- A Decodo **Residential** proxy plan of your own.
- The proxy username and password from your Decodo dashboard. The `user-` prefix the parameter syntax needs is added for you when the saved username lacks it.
- Proxy QA Browser for [Windows, Linux or macOS](/#download).

## Set up Decodo in the app

1. Open **Manage keys** on the Launch page (or **Settings → Advanced → Proxy keys → Manage keys…**) and choose the provider **Decodo (formerly Smartproxy)**.
2. On the **Residential** tab, **Proxy host** and **Port** are pre-filled with the gateway `gate.decodo.com:7000`.
3. Enter the username and password, click **Test connection**, then **Save encrypted**.

Credentials are stored in the [encrypted vault](/docs/security-and-privacy) and never shown in previews, logs or run history.

## Target a US state, city or ZIP code

Choose **Decodo** as the **Proxy provider** on the Launch page, then an **Exit location**. The app appends `-`-separated parameters to `user-<username>`:

| Target | Parameters added to the username |
| --- | --- |
| Country | `-country-us` |
| State | `-country-us-state-us_new_jersey` |
| City | `-country-us-state-us_new_jersey-city-newark` |
| ZIP code | `-country-us-zip-07102` |

Multi-word names use underscores (`us_new_york`, `las_vegas`). A city target carries its state, as in Decodo's documented example. State and ZIP targeting are accepted only for United States targets. The **Will connect as** line shows the exact string before you launch.

## Sticky and rotating sessions

Sticky mode adds `-session-<id>`, which Decodo keeps for 10 minutes by default, and `-sessionduration-<minutes>` (1–1440) when you set a **Session TTL**. Session IDs are mapped to a stable alphanumeric token of up to 32 characters. Turn **Sticky session** off for rotating mode.

```text
user-USERNAME-country-us-state-us_new_jersey-session-ql202610077f3a0uv3n6-sessionduration-30
```

## Run Decodo in CI

Set `QA_PROVIDER=decodo`, `QA_PROVIDER_USERNAME` and `QA_PROVIDER_PASSWORD` from your secret store for the [CI runner](/docs/ci-runner#proxy-credentials). The gateway defaults to `gate.decodo.com:7000`.

## Decodo proxy not working?

| Symptom | What to do |
| --- | --- |
| `PROXY_AUTH_FAILED` / HTTP 407 | Re-enter the username and password in **Manage keys**, click **Test connection**, and check the plan in your Decodo dashboard |
| A targeting parameter is refused | Support is community-verified. Check Decodo's advanced parameters documentation, linked from the keys window, and [open an issue](https://github.com/UbaidBinWaris/proxy_browser/issues) with the redacted error |
| `PROXY_DEAD` / `PROXY_TIMEOUT` | **Test** the product under **Settings → Advanced → Proxy keys**, check your firewall and VPN, and rotate the session |
| Location badge **Mismatch** | Use more **Attempts**, a broader target, or the **Same state** policy |

More error codes are in [Troubleshooting](/docs/troubleshooting#proxy-and-location). All providers side by side: [Proxy providers](/docs/proxy-providers).

## Next steps

Plan the tests themselves with [location testing](/use-cases/location-testing) and [geo-blocking testing](/use-cases/geo-blocking-testing), then [record a scenario](/docs/automation) to repeat them across locations, devices and browsers.
