# Platform support

## Supported systems

| Platform | Collector | Deployment | Notes |
|---|---|---|---|
| Linux distributions with `/proc` and `/sys` | `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `/proc/mounts`, `/proc/<pid>`, thermal and hwmon sysfs | systemd unit included; manual Node launch works without systemd | Designed to avoid distro-specific libraries. Visibility depends on kernel mounts, namespaces, hidepid, container boundaries and sensor drivers. |
| macOS | Node OS APIs plus `/usr/bin/vm_stat`, `/bin/df`, `/usr/sbin/netstat`, `/bin/ps` | Manual `npm start`; organization-managed launchd integration is possible | Built-in command output can differ across major OS versions. Validate on the target macOS release before unattended rollout. |

Node.js 20 or newer is required. No npm dependencies or elevated privileges are required for normal collection.

## macOS details and limitations

- CPU percentages use `os.cpus()` time-counter deltas.
- Memory uses VM page counts from `vm_stat` and total memory from Node.
- Filesystem usage uses `df -Pk`; aggregate capacity counts each device once, while the storage page retains mount points.
- Network counters use `netstat -ibn`; duplicate address rows are collapsed by taking the maximum counter values per interface.
- Processes use `ps -axo`; only the process name and resource metadata are exposed.
- Apple does not provide ordinary unprivileged processes a stable built-in CPU temperature API. AETHER reports no temperature sensor values on macOS unless a future supported source is explicitly added; it does not invoke privileged or third-party sensor utilities.

## Linux details and limitations

- CPU uses aggregate jiffy counter deltas and excludes the duplicated guest counters.
- Memory uses `MemAvailable`.
- Disk statistics use Node's `statfs` against device-backed mount points.
- Network rates exclude loopback.
- Process collection reads `stat` and `status`, with bounded concurrent reads and race-tolerant handling for processes that exit mid-sample.
- Thermal zones and hwmon sensors are optional; sensors which are absent, inaccessible, or transiently unavailable are skipped.

## Browser support

Use a current Safari, Firefox, or Chromium-based browser with support for `EventSource`, `localStorage`, Canvas 2D, CSS custom properties, and the HTML dialog element. The interface uses native system font stacks, so no external font service is contacted. Responsive breakpoints provide a bottom navigation rail on narrow screens.

## Verification matrix

Run the parser and service test suite on each release host:

```sh
npm test
npm run check
```

Linux systemd deployments can additionally run:

```sh
systemd-analyze verify systemd/healthdash.service
```

The macOS parsers have fixture tests, but a live target-machine test is still required when certifying a macOS version.
