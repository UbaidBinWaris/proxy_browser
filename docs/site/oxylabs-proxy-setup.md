# Oxylabs proxy setup

To test your own site through an Oxylabs Residential Proxies plan, save the plan's username and password in Proxy QA Browser, pick a US state, city or ZIP code on the Launch page, and the app builds the Oxylabs username parameters, checks the exit IP's location and opens the browser. Oxylabs support is **community-verified**: written from Oxylabs' parameter documentation and not tested with a live account. Proxy QA Browser does not sell proxies and is [not affiliated with or endorsed by Oxylabs](/docs/introduction#license).

## What you need

- An Oxylabs **Residential Proxies** plan of your own.
- The proxy username and password from your Oxylabs dashboard. The mandatory `customer-` prefix is added for you when the saved username lacks it.
- Proxy QA Browser for [Windows, Linux or macOS](/#download).

## Set up Oxylabs in the app

1. Open **Manage keys** on the Launch page (or **Settings → Advanced → Proxy keys → Manage keys…**) and choose the provider **Oxylabs**.
2. On the **Residential** tab, **Proxy host** and **Port** are pre-filled with the entry node `pr.oxylabs.io:7777`.
3. Enter the username and password, click **Test connection**, then **Save encrypted**.

Credentials are stored in the [encrypted vault](/docs/security-and-privacy) and never shown in previews, logs or run history.

## Target a US state, city or ZIP code

Choose **Oxylabs** as the **Proxy provider** on the Launch page, then an **Exit location**. The app appends `-`-separated parameters to `customer-<username>`:

| Target | Parameters added to the username |
| --- | --- |
| Country | `-cc-US` |
| State | `-st-us_new_jersey` |
| City | `-cc-US-city-newark` |
| ZIP code | `-cc-US-postalcode-07102` |

Multi-word names use underscores (`us_new_york`, `los_angeles`, `st_louis`). States come from Oxylabs' published list of 50 states: the District of Columbia is not on it, so a DC state target is refused with `INVALID_INPUT`; target a city or ZIP code there instead. State and ZIP targeting are accepted only for United States targets. The **Will connect as** line shows the exact string before you launch.

## Sticky and rotating sessions

Sticky mode adds `-sessid-<id>`, which Oxylabs keeps for 10 minutes by default, and `-sesstime-<minutes>` (1–1440) when you set a **Session TTL**. Session IDs are mapped to a stable alphanumeric token of up to 32 characters. Turn **Sticky session** off for rotating mode.

```text
customer-USERNAME-st-us_new_jersey-sessid-ql202610077f3a0uv3n6-sesstime-30
```

## Run Oxylabs in CI

Set `QA_PROVIDER=oxylabs`, `QA_PROVIDER_USERNAME` and `QA_PROVIDER_PASSWORD` from your secret store for the [CI runner](/docs/ci-runner#proxy-credentials). The gateway defaults to `pr.oxylabs.io:7777`.

## Oxylabs proxy not working?

| Symptom | What to do |
| --- | --- |
| `PROXY_AUTH_FAILED` / HTTP 407 | Re-enter the username and password in **Manage keys**, click **Test connection**, and check the plan in your Oxylabs account |
| `INVALID_INPUT` for a state | Oxylabs does not list that state (for example DC). Target a city or ZIP code there |
| A targeting parameter is refused | Support is community-verified. Check Oxylabs' location settings documentation, linked from the keys window, and [open an issue](https://github.com/UbaidBinWaris/proxy_browser/issues) with the redacted error |
| Location badge **Mismatch** | Use more **Attempts**, a broader target, or the **Same state** policy |

More error codes are in [Troubleshooting](/docs/troubleshooting#proxy-and-location). All providers side by side: [Proxy providers](/docs/proxy-providers).

## Next steps

Plan the tests themselves with [location testing](/use-cases/location-testing) and [geo-blocking testing](/use-cases/geo-blocking-testing), then [record a scenario](/docs/automation) to repeat them across locations, devices and browsers.
