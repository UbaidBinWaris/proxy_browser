# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through **GitHub → Security → Report a
vulnerability** on this repository. Do not open a public issue, pull request or
discussion for a suspected vulnerability.

Include the affected version, platform (Windows/Linux), reproduction steps and
impact. Never include real proxy credentials, cookies or personal data; use
placeholders.

You can expect an acknowledgement within 7 days and a status update at least
every 14 days until the report is resolved. Fixed issues are credited in the
release notes unless you ask otherwise.

## Supported versions

Only the latest released version receives security fixes.

## In scope

- Credential vault: key handling, encryption, OS keychain integration, plaintext exposure.
- Secrets reaching logs, diagnostics exports, reports, screenshots or crash output.
- Electron hardening: context isolation, preload bridge, IPC validation, navigation and window-open handling.
- The local proxy relay and its listening interface.
- Update verification: manifest signatures, downgrade protection, artifact hashes.
- Configuration backup encryption and restore validation.
- Origin isolation in QA automation (approved-origin enforcement).

## Out of scope

- Behaviour of third-party proxy providers, IP-check services or installed vendor browsers.
- Accuracy of IP geolocation data.
- Requests to bypass bot detection, CAPTCHA or fraud controls. These are not
  vulnerabilities, and such features are outside the project's scope
  (see [CONTRIBUTING.md](CONTRIBUTING.md#project-scope)).
