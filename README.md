# AETHER — Local Systems Observatory

> A vivid, full-screen operations console for Linux and macOS. Live host telemetry, no cloud, no dependency stack.

A dependency-free, localhost-only, multi-page operations console for live CPU, memory, disk, temperature, network and process telemetry on Linux and macOS. The interface includes overview, process inspection, network telemetry, storage maps and preferences. Appearance, accent, density and temperature-unit preferences are saved in the browser.

## Requirements

- A supported Linux distribution with standard `/proc` and `/sys` mounts, or macOS
- Node.js 20 or later

No npm packages, database, cloud account, browser extensions or outbound telemetry are required. Modern Safari, Firefox and Chromium-based browsers are supported. AETHER is implemented in dependency-free Node.js JavaScript plus native browser JavaScript, HTML and CSS; see [Architecture](docs/ARCHITECTURE.md#technology-choice) for why this is a good fit versus introducing a frontend framework or a second systems language.

## Experience

AETHER uses a high-saturation neon observatory palette, display serif typography paired with monospaced telemetry labels, responsive desktop/mobile navigation, colored resource histories, and a full-page local signal journal. Navigate Overview, Processes, Network, Storage and Preferences. The command palette (`Ctrl/⌘+K`) jumps to any page or action. The Overview health pulse is a derived trend indicator, not a hardware diagnostic. Theme, accent, display name, density and temperature unit are customizable.

### Platform support

- **Linux distributions:** reads the common Linux `/proc` and `/sys` interfaces, so it works across mainstream systemd and non-systemd distributions without distro-specific packages. Temperature readings depend on available kernel sensor drivers and permissions.
- **macOS:** uses built-in `vm_stat`, `df`, `netstat`, `ps`, and Node.js system APIs for memory, disks, network, processes, CPU and uptime. macOS does not expose CPU temperature to ordinary processes through a stable built-in API; the temperature card reports no sensor data instead of requiring elevated privileges or installing a third-party sensor driver.
- **Service deployment:** the included systemd unit is Linux-only. On macOS, run it interactively with `npm start` or integrate it with your organization’s launchd policy.

## Run locally

```sh
npm test
npm run check
npm start
```

Open <http://127.0.0.1:8765>. The operating-system account name is collected locally using Node.js `os.userInfo()` and shown in the identity panel. A preferred display name may override it; otherwise the host username is used. Choose an accent, light/dark/system appearance, Celsius/Fahrenheit, or compact density in Preferences. Browser preferences remain in that browser only. The appearance button cycles through system, dark and light modes.

To select another local port, set `HEALTHDASH_PORT`. The service accepts only `127.0.0.1`, `::1`, or `localhost`; it refuses non-loopback binds. For remote administration, use an SSH tunnel from your workstation:

```sh
ssh -N -L 8765:127.0.0.1:8765 user@your-linux-host
```

Then open <http://127.0.0.1:8765> locally. The browser will ask for the generated local username and password. On first run, credentials are written to `~/.config/aether/credentials.json` with owner-only permissions; read them from your local account and enter them into the browser prompt. Do not put this service directly on a LAN or the public internet.

For managed deployments, set both `HEALTHDASH_USERNAME` and `HEALTHDASH_PASSWORD` (password must be at least 16 characters and must not contain `:` or a newline), or set `HEALTHDASH_CREDENTIALS_FILE` to a JSON file containing `{"username":"…","password":"…"}` with owner-only permissions. Partial or malformed credentials fail closed. Keep the credentials file private and rotate it by stopping the service, replacing the file with a new owner-only JSON file, and restarting.

## Production installation (systemd)

Create a dedicated unprivileged account and install the application and unit:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin healthdash
sudo install -d -o root -g healthdash -m 0750 /opt/linux-health-dashboard
sudo cp -R package.json server.mjs metrics.mjs public /opt/linux-health-dashboard/
sudo chown -R root:healthdash /opt/linux-health-dashboard
sudo install -m 0644 systemd/healthdash.service /etc/systemd/system/healthdash.service
sudo systemctl daemon-reload
sudo systemctl enable --now healthdash
systemctl status healthdash
```

The provided unit runs as the unprivileged `healthdash` user, binds only to loopback, has no Linux capabilities, enables systemd filesystem/kernel protections, keeps the application tree read-only, and stores generated credentials in a mode-0700 systemd state directory. After the first start, retrieve the browser credentials with `sudo cat /var/lib/aether/credentials.json`. Review the unit against your host's systemd version and local policy before rollout. Logs are available with `journalctl -u healthdash`.

## Metrics and behavior

- On Linux, CPU utilization uses `/proc/stat` counter deltas, memory uses `MemAvailable`, and filesystem capacity is collected with `statfs`.
- On macOS, CPU is derived from `os.cpus()` time deltas, memory from `vm_stat`, and volume capacity from `df`.
- Thermal readings are best-effort from thermal zones and hwmon sensors in sysfs.
- Linux network rates come from `/proc/net/dev`; macOS rates come from `netstat -ibn`. Loopback is excluded.
- Linux process information comes from procfs; macOS process information comes from `ps`. The Processes page filters by name/PID and state, sorts columns, pauses the visual feed, and shows a privacy-limited process dossier. The overview provides live workload shortcuts.
- Network and Storage have dedicated multi-page explorers with per-interface ordering, mount-point ordering, aggregate capacity visualization and volume details.
- `/api/metrics` returns a JSON snapshot; `/api/events` streams JSON snapshots once per second.

Some process details, disks and sensor data can be unavailable due to host configuration or procfs/sysfs access controls. The displayed username is the account running the service (for example, the dedicated `healthdash` user under the provided systemd unit). Metrics, static assets, and event streams all require HTTP Basic authentication. macOS does not expose temperature through the built-in unprivileged interfaces used here, so no sensor driver or root access is assumed. Metrics are host-wide and may be sensitive; keep the service private.

## Security and validation

The service has no third-party runtime dependencies. It uses an explicit static-asset allowlist rather than mapping user paths to disk, requires authentication for all routes, rejects non-GET methods and non-loopback `Host` headers (including DNS-rebinding attempts), emits restrictive browser security headers and has no CORS allowance. It binds to loopback only and does not expose process command lines, environment variables, or file contents.

Run `npm test` and `npm run check` before deployment. The automated security-focused tests cover authentication, loopback-only binding, foreign `Host` rejection, path traversal, HTTP method handling, restrictive headers/no CORS, error-detail containment and shared live-stream sampling. Dependency audit is not applicable because `package.json` declares no dependencies. For deployment, also scan the target host/runtime with approved scanners; this project cannot certify the host, kernel, or deployment environment.

## Documentation

- [Architecture and technology choice](docs/ARCHITECTURE.md)
- [Linux/macOS support matrix](docs/PLATFORM_SUPPORT.md)
- [Security model and VAPT checklist](docs/SECURITY.md)
- [Operations and troubleshooting](docs/OPERATIONS.md)
- [MIT license](LICENSE)
