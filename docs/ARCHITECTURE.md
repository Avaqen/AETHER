# Architecture

AETHER is a single-host, local-first telemetry service. It has no database, package dependencies, CDN dependencies, cloud calls, or build step.

## Technology choice

The service and collectors use modern JavaScript on Node.js; the interface uses browser JavaScript, semantic HTML, and CSS. This is a deliberate fit for a small single-user observability tool:

- Node's built-in APIs support HTTP, streaming, filesystem reads, process inspection, cryptography, and platform-specific commands without native addons.
- The same language is used across the service and UI.
- The application is dependency-free, easy to audit, and runs on both Linux and macOS.
- The front end uses native browser APIs (canvas, `EventSource`, `localStorage`, and the dialog element) without a framework bundle.

TypeScript is an excellent choice for a larger team or evolving API, but a migration here would add a compiler/toolchain without improving the operating-system compatibility or runtime correctness of this compact service. If the UI grows into shared components or plugins, adopting TypeScript with a typed telemetry schema would be a reasonable next step.

## Request and data flow

1. `server.mjs` validates the loopback listener and loads an owner-only credential pair.
2. All requests pass a loopback `Host` check and HTTP Basic authentication before static files, the JSON snapshot endpoint, or the event stream are served.
3. `metrics.mjs` selects the Linux or macOS collector using `process.platform`.
4. The collector samples platform APIs once per second while an event-stream client is connected. Delta counters provide CPU and network rates.
5. `/api/events` broadcasts one shared snapshot to all authenticated browser tabs; `/api/metrics` returns a one-shot JSON snapshot.
6. The UI renders telemetry, derives an approximate health score and threshold-crossing journal, and stores only display preferences in browser-local storage.

The health score is a compact trend cue derived from current CPU, memory, unique-device storage usage, and temperature readings. It is not a diagnostic or hardware-health guarantee.

## Main modules

- `server.mjs`: loopback-only HTTP server, static asset allowlist, auth, credential file lifecycle, SSE.
- `metrics.mjs`: Linux `/proc` and `/sys` collector, macOS built-in command collector, parsers and platform snapshot schema.
- `public/index.html`: application shell and page markup.
- `public/app.js`: routing, user interactions, charts, event journal, preference persistence, and snapshot rendering.
- `public/styles.css`: themes, responsive layout, and visual system.
- `systemd/healthdash.service`: hardened Linux deployment example.

## Frontend route map

The client-side hash routes work without a reverse proxy or history fallback:

- `#/overview`: resource summary, network pulse, storage preview, busiest processes, health pulse and local event journal.
- `#/processes`: filterable, sortable process list, pause/resume and limited process metadata.
- `#/network`: per-interface receive/transmit rates and totals.
- `#/storage`: volume mount map and unique-device aggregate capacity.
- `#/settings`: local display name, theme, accent, density, temperature unit and OS identity.

The command palette opens with `Ctrl/⌘+K`; `Ctrl/⌘+F` jumps to process search.

## Platform snapshot schema

Both collectors produce compatible snapshots containing:

- `timestamp`, `hostname`, `username`, `platform`, `kernel`, `uptimeSeconds`
- `cpu`: percentage, logical core count, load averages
- `memory`: total, used, available, percentage
- `disks`: device, mount point, filesystem type, total/used/available bytes, percentage
- `temperatures`: sensor label and Celsius values, possibly empty
- `network`: per-interface counters and byte rates
- `processes`: name, PID, parent PID, state, CPU percentage, resident memory

Process arguments, environment variables, open files, packet contents, and user data are deliberately excluded.
