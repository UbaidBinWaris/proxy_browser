# Bright Data proxy setup

To test your own site through a Bright Data residential zone, save the zone's username and password in Proxy QA Browser, pick a US state, city or ZIP code on the Launch page, and the app appends the Bright Data targeting parameters, checks the exit IP's location and opens the browser. Bright Data support is **community-verified**: written from Bright Data's parameter documentation and not tested with a live account. Proxy QA Browser does not sell proxies and is [not affiliated with or endorsed by Bright Data](/docs/introduction#license).

## What you need

- A Bright Data **Residential** zone of your own.
- The zone's username as shown in the Bright Data control panel, `brd-customer-<customer id>-zone-<zone name>`, without any targeting parameters, and the zone password.
- Proxy QA Browser for [Windows, Linux or macOS](/download).

## Set up Bright Data in the app

1. Open **Manage keys** on the Launch page (or **Settings → Advanced → Proxy keys → Manage keys…**) and choose the provider **Bright Data**.
2. On the **Residential** tab, **Proxy host** and **Port** are pre-filled with the gateway `brd.superproxy.io:44445`.
3. Enter the zone username and password, click **Test connection**, then **Save encrypted**.

Credentials are stored in the [encrypted vault](/docs/security-and-privacy) and never shown in previews, logs or run history.

## Target a US state, city or ZIP code

Choose **Bright Data** as the **Proxy provider** on the Launch page, then an **Exit location**. The app appends `-`-separated parameters to the zone username:

| Target | Parameters added to the username |
| --- | --- |
| Country | `-country-us` |
| State | `-country-us-state-nj` (the USPS state code) |
| City | `-country-us-city-newark` |
| ZIP code | `-city-newark-zip-07102` |

City names are lower case without spaces (`sanfrancisco`). State and ZIP targeting are accepted only for United States targets. The **Will connect as** line shows the exact string before you launch.

## Sticky and rotating sessions

Sticky mode adds `-session-<id>` and keeps one exit IP. Bright Data has **no session lifetime parameter**: a session ends after about 5 idle minutes, so the **Session TTL** field is ignored. Bright Data accepts only letters and digits in session IDs, so the app maps your profile's session ID to a stable alphanumeric token. Turn **Sticky session** off for rotating mode.

```text
brd-customer-EXAMPLE-zone-EXAMPLE-country-us-state-nj-session-ql202610077f3a0uv3n6
```

## Run Bright Data in CI

Set `QA_PROVIDER=brightdata`, `QA_PROVIDER_USERNAME` and `QA_PROVIDER_PASSWORD` from your secret store for the [CI runner](/docs/ci-runner#proxy-credentials). The gateway defaults to `brd.superproxy.io:44445`.

## Bright Data proxy not working?

| Symptom | What to do |
| --- | --- |
| `PROXY_AUTH_FAILED` / HTTP 407 | Check the zone username (no targeting parameters in it) and password in **Manage keys**, and that the zone is active and allows the targeting you chose |
| A targeting parameter is refused | Support is community-verified. Check Bright Data's parameter documentation, linked from the keys window, and [open an issue](https://github.com/UbaidBinWaris/proxy_browser/issues) with the redacted error |
| Exit IP changes mid-test | The session was idle for more than about 5 minutes. Launch again, or keep the page active |
| Location badge **Mismatch** | Use more **Attempts**, a broader target, or the **Same state** policy |

More error codes are in [Troubleshooting](/docs/troubleshooting#proxy-and-location). All providers side by side: [Proxy providers](/docs/proxy-providers).

## Next steps

Plan the tests themselves with [location testing](/use-cases/location-testing) and [geo-blocking testing](/use-cases/geo-blocking-testing), then [record a scenario](/docs/automation) to repeat them across locations, devices and browsers.
