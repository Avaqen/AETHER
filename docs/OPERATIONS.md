# Operations guide

## Local startup

```sh
npm test
npm run check
npm start
```

On the first run, AETHER prints the location of a generated credential file. Read the file locally and enter the displayed username/password in the browser prompt. AETHER listens on `127.0.0.1:8765` by default.

Configuration:

| Variable | Default | Purpose |
|---|---|---|
| `HEALTHDASH_HOST` | `127.0.0.1` | Must be `127.0.0.1`, `::1`, or `localhost`. External binds are rejected. |
| `HEALTHDASH_PORT` | `8765` | Local TCP port, integer 1–65535. |
| `HEALTHDASH_CREDENTIALS_FILE` | `~/.config/aether/credentials.json` | Owner-only credentials file path. |
| `HEALTHDASH_USERNAME` | OS account name | Optional managed username; must be set alongside password. |
| `HEALTHDASH_PASSWORD` | generated random secret | Optional managed secret, minimum 16 characters; must not contain a colon or newline. |

When credentials are set by environment, both username and password must be present. Environment values are inherited by the service process; prefer a root-owned, tightly permissioned systemd `EnvironmentFile` or credentials-file management approach in production rather than shell history.

## systemd on Linux

Follow the installation commands in the project README. The example service runs as `healthdash` with a writable state directory for credentials. After first start:

```sh
sudo systemctl status healthdash
sudo journalctl -u healthdash
sudo cat /var/lib/aether/credentials.json
```

To rotate generated credentials, stop the service, replace the credential file with a valid owner-only JSON document, then restart it. Do not copy live secrets into shell transcripts, support tickets, or Git.

## macOS

Run `npm start` from a terminal session. For a persistent user service, create and review a launchd plist that sets a private credential path and starts Node under the intended local account. AETHER does not install or modify launchd configuration automatically.

## Remote access

Use a workstation SSH tunnel instead of changing the bind address:

```sh
ssh -N -L 8765:127.0.0.1:8765 user@your-host
```

Browse to `http://127.0.0.1:8765` on the workstation and authenticate. Do not expose the HTTP listener directly on the LAN or internet.

## Troubleshooting

- **401 response:** inspect the configured credentials source and ensure the browser prompts for the correct user.
- **Credential file refused:** ensure it is a regular file owned by the AETHER service account with mode `0600` or stricter; symlinks are not accepted.
- **Port in use:** set `HEALTHDASH_PORT` to a free port and update the browser/tunnel accordingly.
- **No temperature readings:** sensor readings are optional on Linux; macOS does not provide these through the built-in unprivileged path.
- **Missing processes or mounts:** procfs visibility, containers, mount namespaces, permissions, and host policy can limit available data.
- **macOS collector command fails:** confirm `/usr/bin/vm_stat`, `/bin/df`, `/usr/sbin/netstat`, and `/bin/ps` exist and inspect local logs. Validate against the specific macOS release.

## UI controls

- `Ctrl/⌘+K`: open the command palette.
- `Ctrl/⌘+F`: jump to process search.
- Process explorer: search by process name/PID, filter by state, sort columns, pause/resume display and open a metadata-only dossier.
- Network page: order interfaces by name or traffic.
- Storage page: order volumes by mount point, usage, or size.
- Preferences: browser-local display name, appearance, accent, temperature unit and layout density.
