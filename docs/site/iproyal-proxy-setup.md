# IPRoyal proxy setup

To test your own site through an IPRoyal residential plan, save the plan's proxy username and password in Proxy QA Browser, pick a US state or city on the Launch page, and the app adds the IPRoyal targeting parameters to the password, checks the exit IP's location and opens the browser. IPRoyal support is **community-verified**: written from IPRoyal's parameter documentation and not tested with a live account. Proxy QA Browser does not sell proxies and is [not affiliated with or endorsed by IPRoyal](/docs/introduction#license).

## What you need

- An IPRoyal **Residential** proxy plan of your own.
- The proxy username and password from your IPRoyal dashboard, without any targeting parameters.
- Proxy QA Browser for [Windows, Linux or macOS](/#download).

## Set up IPRoyal in the app

1. Open **Manage keys** on the Launch page (or **Settings → Advanced → Proxy keys → Manage keys…**) and choose the provider **IPRoyal**.
2. On the **Residential** tab, **Proxy host** and **Port** are pre-filled with the gateway `geo.iproyal.com:12321`.
3. Enter the username and password, click **Test connection**, then **Save encrypted**.

Credentials are stored in the [encrypted vault](/docs/security-and-privacy) and never shown in previews, logs or run history.

## Target a US state or city

IPRoyal carries every setting in the **password**: the app appends `_key-value` parameters to it and sends the username unchanged. Choose **IPRoyal** as the **Proxy provider** on the Launch page, then an **Exit location**:

| Target | Parameters added to the password |
| --- | --- |
| Country | `_country-us` |
| State | `_country-us_state-newjersey` |
| City | `_country-us_city-newark` |

State and city names are lower case without spaces (`newjersey`). IPRoyal does not document ZIP targeting for residential proxies, so the Launch page offers no **ZIP** mode for IPRoyal. State targeting is accepted only for United States targets. Because the parameters are part of the password, the **Will connect as** line shows only the parameter part, never the password itself.

## Sticky and rotating sessions

Sticky mode adds `_session-<id>`, where IPRoyal requires exactly 8 letters and digits; the app maps your profile's session ID to a stable 8-character token. A **Session TTL** is sent as `_lifetime-<N>m`, up to 7 days. Turn **Sticky session** off for rotating mode.

```text
PASSWORD_country-us_state-newjersey_session-0uv3n6d0_lifetime-30m
```

## Run IPRoyal in CI

Set `QA_PROVIDER=iproyal`, `QA_PROVIDER_USERNAME` and `QA_PROVIDER_PASSWORD` from your secret store for the [CI runner](/docs/ci-runner#proxy-credentials). The gateway defaults to `geo.iproyal.com:12321`.

## IPRoyal proxy not working?

| Symptom | What to do |
| --- | --- |
| `PROXY_AUTH_FAILED` / HTTP 407 | Re-enter the username and the bare password (no `_country-…` parameters) in **Manage keys**, click **Test connection**, and check the plan in your IPRoyal dashboard |
| A multi-word state or city is refused | IPRoyal's examples use single words. Check the location code against IPRoyal's location list, linked from the keys window, and [open an issue](https://github.com/UbaidBinWaris/proxy_browser/issues) with the redacted error |
| No ZIP option | Expected: IPRoyal has no documented ZIP targeting. Target the city instead |
| Location badge **Mismatch** | Use more **Attempts**, a broader target, or the **Same state** policy |

More error codes are in [Troubleshooting](/docs/troubleshooting#proxy-and-location). All providers side by side: [Proxy providers](/docs/proxy-providers).

## Next steps

Plan the tests themselves with [location testing](/use-cases/location-testing) and [geo-blocking testing](/use-cases/geo-blocking-testing), then [record a scenario](/docs/automation) to repeat them across locations, devices and browsers.
