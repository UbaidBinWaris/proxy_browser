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

Sticky mode adds `-session-<id>` and keeps one exit IP. Bright Data has **no session lifetime parameter**: a session ends after about 5 idle minutes, so the **Session TTL** field is ignored. While the browser is open, the app's IP re-check every 20 seconds keeps the session from going idle. Bright Data accepts only letters and digits in session IDs, so the app maps your profile's session ID to a stable alphanumeric token. Turn **Sticky session** off for rotating mode.

```text
brd-customer-EXAMPLE-zone-EXAMPLE-country-us-state-nj-session-ql202610077f3a0uv3n6
```

## Use Bright Data proxies without a browser extension

You do not need a browser extension or a system-wide proxy setting. When you click **Connect & Launch**, the app starts the browser you picked (bundled Chromium, Firefox or WebKit, or your installed Chrome, Edge, Brave or Opera) with the Bright Data login applied to that one browser, in a fresh temporary profile. Your other browser windows and apps keep their normal connection, and your own bookmarks, cookies and extensions are never touched. It works the same way on Windows, Linux and macOS.

## Check that your Bright Data proxy works

- **Test connection** in **Manage keys** sends one request through the Bright Data gateway with the login you typed and shows the result. Nothing is saved.
- **Test Proxy** on a saved profile (Profiles page) runs one IP check through that profile's pool, location and sticky session.
- **Every launch** looks up the exit IP through the same login the browser will use, before the window opens, and shows the IP with its city, state and approximate ZIP (shown as ≈ 07102, because IP-location services disagree on ZIP codes for the same IP), plus a **Match**, **Partial** or **Mismatch** badge against your target.
- **Sticky sessions are watched**: the IP is checked a second time 3 seconds later, and a fresh session is tried if it changed. While the browser is open the IP is re-checked every 20 seconds, and the browser is **stopped** if it changes, so a form is never sent from a second IP.

## Run Bright Data in CI

Set `QA_PROVIDER=brightdata`, `QA_PROVIDER_USERNAME` and `QA_PROVIDER_PASSWORD` from your secret store for the [CI runner](/docs/ci-runner#proxy-credentials). The gateway defaults to `brd.superproxy.io:44445`.

## Bright Data proxy not working?

| Symptom | What to do |
| --- | --- |
| `PROXY_AUTH_FAILED` / HTTP 407 | Check the zone username (no targeting parameters in it) and password in **Manage keys**, and that the zone is active and allows the targeting you chose |
| A targeting parameter is refused | Support is community-verified. Check Bright Data's parameter documentation, linked from the keys window, and [open an issue](https://github.com/UbaidBinWaris/proxy_browser/issues) with the redacted error |
| Browser stopped: *"the IP address changed"* | Bright Data replaced the session's IP (it ends sessions idle for about 5 minutes; the app's 20-second re-check normally keeps it active). Click **Launch again** |
| Location badge **Mismatch** | Use more **Attempts**, a broader target, or the **Same state** policy |

More error codes are in [Troubleshooting](/docs/troubleshooting#proxy-and-location). All providers side by side: [Proxy providers](/docs/proxy-providers).

## Next steps

Plan the tests themselves with [location testing](/use-cases/location-testing) and [geo-blocking testing](/use-cases/geo-blocking-testing), then [record a scenario](/docs/automation) to repeat them across locations, devices and browsers.
