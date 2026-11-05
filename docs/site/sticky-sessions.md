# Sticky sessions: keep one proxy IP

A sticky session asks a proxy provider to keep one exit IP for a while. That matters for forms: lead-certificate scripts and your own server logs record the IP a page is loaded from, so if the IP changes halfway through a visit, one visitor looks like two, often in the same state but another city. This page explains why a "sticky" IP still changes, what we measured with DataImpulse, and how Proxy QA Browser keeps one IP for a whole visit.

## Why a sticky proxy IP changes

1. **The session lifetime ran out.** A sticky session lasts as long as its lifetime parameter. Without one, the provider's default applies: about 5 minutes for DataImpulse in our test, 10 minutes for Oxylabs and Decodo by their documentation, and about 5 idle minutes for Bright Data, which has no lifetime parameter.
2. **The exit IP went offline.** Residential IPs are home connections. When one disconnects, the provider swaps in another IP in the same area, which DataImpulse's own documentation describes. No setting prevents this.
3. **The session never held.** Some sessions changed IP on every request, whatever lifetime was asked for.

The replacement IP is usually in the same country and state, because the targeting parameters still apply, but rarely in the same city. That is why a website can record the right state and the wrong town.

## What we measured with DataImpulse

Measured on 30 October 2026 with a DataImpulse Residential plan through `gw.dataimpulse.com:823`, US state targeting in Oklahoma, New Jersey and Texas, checking the exit IP through each session every 20 seconds:

| Lifetime in the username | What happened to the exit IP |
| --- | --- |
| None (`sessid` only) | Every session switched to another IP, in the same state but another city, about 5 minutes after it started |
| `sessttl.10` | Switched at about 10 minutes, as asked |
| `sessttl.15` | Held for the whole test, more than 10 minutes |
| `sessttl.30` and `sessttl.60` | Held for the whole 7.5-minute test |
| `sessttl.120` | Unreliable: one Texas session got a new IP on every request |

- In a second test, 2 of 8 Texas sessions changed IP between two checks only 3 seconds apart, whatever lifetime they had. The other six held.
- The gateway name resolves to two servers, and both returned the same IP for the same session, so which server answers is not the cause.
- IP-location services disagree on ZIP codes: the same Seattle IP was placed in 98104 by one service and 98101 by another. Compare IP addresses, not ZIP codes.

This is one provider, a small sample and one month. Providers change their pools, so measure your own plan with the steps below before you rely on these numbers.

## How to keep one IP for a whole visit

- **Always send a lifetime longer than the visit.** For a 5 to 10 minute visit, 15 minutes is enough and releases the IP soon after. DataImpulse lifetimes above 60 minutes were unreliable, so the app caps them at 60.
- **Use a fresh session ID for each visit**, so a new visit never inherits the end of an old session.
- **Check the IP twice before you start.** Look it up through the session, wait 3 seconds, look it up again. If it changed, that session will not hold: take a new session ID.
- **Keep watching while the page is open.** Re-check the IP every 20 seconds through the same session, and stop before the form is sent if it changed.
- **Use rotating mode only where a changing IP is fine.** Rotating sessions use a different IP for every request, so the IP you looked up is only a sample of what the website sees.

## How Proxy QA Browser does it

Every sticky launch follows those rules without any setup:

- A lifetime is always sent: the profile's **Session TTL**, else **Settings → Advanced → Targeting → Keep the same IP for (minutes)**, 15 by default. Each provider's limit applies; see each provider's guide under [Proxy providers](/docs/proxy-providers#sticky-and-rotating-sessions).
- Before the browser opens, the exit IP is looked up through the same login the browser will use, then checked again 3 seconds later. If it changed, the app tries a fresh session; after three unstable sessions in a row it stops with `IP_UNSTABLE` and does not open a browser.
- While the browser is open, the IP is re-checked every 20 seconds. If it changes, the app blocks every request from the browser, closes it and shows **"Browser stopped: the IP address changed"** with both IPs and places, as a dialog and a system notification. The change is saved on the run, so History shows it later.
- The location shown next to the IP comes from an IP-location service, and ZIP codes are shown as approximate (≈ 98104). See [Exit-IP verification](/docs/locations-and-devices#exit-ip-verification).

## Check a session yourself with curl

To see how your own plan behaves, look up the exit IP through one sticky session a few times. With DataImpulse, put your login and password in place of `LOGIN` and `PASSWORD`:

```bash
for i in 1 2 3; do
  curl -s -x http://gw.dataimpulse.com:823 \
    -U 'LOGIN__cr.us;state.texas;sessid.mytest1;sessttl.15:PASSWORD' \
    https://api.ipify.org; echo
  sleep 3
done
```

Three identical IPs mean the session holds; different ones mean it does not. Run it again after 5 and 10 minutes to see the lifetime at work. Never paste your real login into a shared terminal log or a bug report.

## Related

- [DataImpulse proxy setup](/docs/dataimpulse-proxy-setup) and the other provider setup guides
- [Troubleshooting proxies and locations](/docs/troubleshooting#proxy-and-location)
- [Test your website from different locations](/use-cases/location-testing)
