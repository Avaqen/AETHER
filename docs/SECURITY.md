# Security and VAPT notes

## Security boundary

AETHER is a local administration interface. It binds to IPv4 or IPv6 loopback only, validates request `Host` values to reduce DNS-rebinding risk, and requires HTTP Basic credentials for the web UI, metrics API, and event stream. It is not an internet-facing service. Do not proxy it onto an untrusted interface without adding an independently reviewed TLS and access-control boundary.

Loopback authentication is application-wide, not per-account authorization. Anyone who can read the credential file or authenticated browser profile can read metrics. Use a dedicated local account and filesystem permissions on shared machines.

## Credential handling

- First run creates a 256-bit random password and stores the username/password pair in `~/.config/aether/credentials.json`.
- The file is created with mode `0600`; its parent directory is requested with mode `0700`.
- Existing credentials must be a regular file owned by the service account and have no group/world permission bits. Symlink credential files are rejected.
- Managed deployments may provide both `HEALTHDASH_USERNAME` and `HEALTHDASH_PASSWORD`, or a JSON credentials file using `HEALTHDASH_CREDENTIALS_FILE`.
- Configured passwords must be at least 16 characters; Basic auth delimiters and newlines are rejected.
- Generated credentials are printed by path only; the secret itself is not logged.
- HTTP Basic authentication does not encrypt credentials. Loopback transport is suitable for the default same-host use; use an SSH tunnel for remote access.

For systemd, `StateDirectory=aether` puts the credential file under `/var/lib/aether/credentials.json` with a private state directory. Read credentials from a trusted local administrative session only.

## Implemented mitigations

- Loopback bind allowlist and request `Host` validation.
- Authentication before serving UI or telemetry.
- Constant-time password comparison when supplied and expected secret lengths match.
- Explicit static asset route allowlist; request paths are never concatenated into filesystem paths.
- GET-only API, no CORS grant, restrictive CSP and browser security headers.
- Generic client error responses; internals go to local service logs.
- macOS system utilities are invoked with fixed absolute executable paths and constant argument arrays through `execFile`; shell interpolation is not used.
- No downloaded scripts, third-party runtime packages, CDN stylesheets, process command-line arguments, environment variables, open files, or packet payloads are included in telemetry.
- systemd example drops capabilities, runs unprivileged, protects kernel settings, and makes the app tree read-only.

## VAPT checklist

Run these checks for changes or before deployment:

1. `npm test` — parser, credential lifecycle, and HTTP security tests.
2. `npm run check` — JavaScript syntax validation.
3. `systemd-analyze verify systemd/healthdash.service` on a Linux systemd host.
4. Check unauthenticated access returns 401, authenticated access returns telemetry, and external bind addresses fail to start.
5. Review the target runtime, OS packages, reverse proxies, local account membership and filesystem permission state with approved organization scanners.

An in-repository test suite and source review are not a penetration test or a certification of the host, kernel, Node.js runtime, browser, or deployment environment. Vulnerability scanners are not included because this application has no third-party runtime dependencies.

## Data handling

System telemetry can reveal usernames, hostnames, process names, PIDs, resource use, mount points and network volume. Data is read and served locally and is not sent to a remote service. Preferences are saved in browser `localStorage`; there are no analytics or telemetry uploads.
