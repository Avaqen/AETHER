const $ = (id) => document.getElementById(id);
const history = { cpu: [], temperature: [], receive: [], transmit: [], pulse: [] };
const HISTORY_LENGTH = 48;
const themes = new Set(['system', 'dark', 'light']);
const accents = new Set(['aurora', 'glacier', 'solar', 'nebula']);
const defaults = { name: '', theme: 'system', accent: 'aurora', temperatureUnit: 'C', density: 'comfortable' };
let preferences = readPreferences();
let latestSnapshot;
let latestProcesses = [];
let livePaused = false;
let sortKey = 'cpuPercent';
let sortDirection = -1;
let selectedProcess;
let previousSignalState;
let signalEvents = [];

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem('aether-preferences') ?? '{}');
    return {
      name: typeof saved.name === 'string' ? saved.name.slice(0, 32) : defaults.name,
      theme: themes.has(saved.theme) ? saved.theme : defaults.theme,
      accent: accents.has(saved.accent) ? saved.accent : defaults.accent,
      temperatureUnit: saved.temperatureUnit === 'F' ? 'F' : 'C',
      density: saved.density === 'compact' ? 'compact' : defaults.density
    };
  } catch {
    return { ...defaults };
  }
}

function recordSignals(state) {
  const signals = [];
  const prior = previousSignalState;
  if (!prior) {
    signals.push(['good', 'AETHER connected', `Watching ${latestSnapshot?.hostname ?? 'this host'} as ${latestSnapshot?.username ?? 'local user'}.`]);
  } else {
    for (const [metric, label, threshold, recovery] of [
      ['cpu', 'Processor load', 85, 75],
      ['memory', 'Memory pressure', 90, 80],
      ['disk', 'Storage pressure', 90, 85],
      ['temperature', 'Thermal load', 85, 78]
    ]) {
      const value = state[metric];
      const oldValue = prior[metric];
      if (value !== undefined && oldValue < threshold && value >= threshold) {
        signals.push(['warn', `${label} elevated`, `${value.toFixed(1)}%${metric === 'temperature' ? '°C' : ''} crossed the ${threshold}${metric === 'temperature' ? '°C' : '%'} watchpoint.`]);
      } else if (value !== undefined && oldValue >= threshold && value < recovery) {
        signals.push(['good', `${label} settled`, `Back below the ${recovery}${metric === 'temperature' ? '°C' : '%'} recovery threshold.`]);
      }
    }
    if (prior.sensors === 0 && state.sensors > 0) {
      signals.push(['good', 'Thermal sensors online', `${state.sensors} sensor${state.sensors === 1 ? '' : 's'} now reporting.`]);
    }
  }
  for (const signal of signals) addSignalEvent(...signal);
  previousSignalState = state;
}

function addSignalEvent(level, title, detail) {
  signalEvents.unshift({ level, title, detail, time: new Date().toLocaleTimeString() });
  signalEvents = signalEvents.slice(0, 6);
  const list = $('event-list');
  list.replaceChildren();
  for (const item of signalEvents) {
    const row = createElement('div', `event-row event-${item.level}`);
    row.append(createElement('span', 'event-mark', item.level === 'warn' ? '!' : '✳'));
    const body = createElement('div', 'event-body');
    body.append(createElement('strong', '', item.title), createElement('small', '', item.detail));
    row.append(body, createElement('time', '', item.time));
    list.append(row);
  }
  $('event-count').textContent = `${signalEvents.length} SIGNAL${signalEvents.length === 1 ? '' : 'S'}`;
}

function persistPreferences() {
  try {
    localStorage.setItem('aether-preferences', JSON.stringify(preferences));
    $('save-state').textContent = 'Saved in this browser';
  } catch {
    $('save-state').textContent = 'Browser storage is unavailable; preferences will reset';
  }
}

function systemUsername() {
  return latestSnapshot?.username || 'local user';
}

function displayName() {
  return preferences.name || systemUsername();
}

function applyPreferences() {
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.dataset.accent = preferences.accent;
  document.documentElement.dataset.density = preferences.density;
  $('theme-icon').textContent = preferences.theme === 'dark' ? '☾' : preferences.theme === 'light' ? '☼' : '◐';
  const name = displayName();
  $('identity-name').textContent = name;
  $('identity-avatar').textContent = name[0]?.toUpperCase() || '?';
  $('settings-avatar').textContent = name[0]?.toUpperCase() || '?';
  $('settings-username').textContent = systemUsername();
  $('display-name').value = preferences.name;
  $('theme-select').value = preferences.theme;
  $('temperature-unit').value = preferences.temperatureUnit;
  $('density-select').value = preferences.density;
  document.querySelectorAll('[data-accent-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.accentChoice === preferences.accent));
  });
  if (latestSnapshot) renderGreeting();
  if (latestSnapshot) renderTemperature(latestSnapshot);
}

function renderGreeting() {
  const name = displayName();
  $('greeting').innerHTML = `${escapeHtml(name)},<br><em>your machine in full orbit.</em>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatRate(bytes) {
  return `${formatBytes(bytes)}/s`;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
}

function keepHistory(key, value) {
  history[key].push(value);
  if (history[key].length > HISTORY_LENGTH) history[key].shift();
}

function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart(id, values, color) {
  const canvas = $(id);
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * scale);
  canvas.height = Math.round(bounds.height * scale);
  const context = canvas.getContext('2d');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  if (values.length < 2) return;
  const maximum = Math.max(1, ...values);
  const minimum = Math.min(0, ...values);
  const range = Math.max(1, maximum - minimum);
  const points = values.map((value, index) => ({
    x: index * bounds.width / (HISTORY_LENGTH - 1),
    y: bounds.height - 3 - ((value - minimum) / range) * (bounds.height - 7)
  }));
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.strokeStyle = color;
  context.lineWidth = 1.7;
  context.lineJoin = 'round';
  context.stroke();
  context.lineTo(bounds.width, bounds.height);
  context.lineTo(0, bounds.height);
  context.closePath();
  context.globalAlpha = 0.11;
  context.fillStyle = color;
  context.fill();
  context.globalAlpha = 1;
}

function drawCharts() {
  drawChart('cpu-chart', history.cpu, themeColor('--accent'));
  drawChart('temp-chart', history.temperature, themeColor('--heat'));
  drawChart('rx-chart', history.receive, themeColor('--inbound'));
  drawChart('tx-chart', history.transmit, themeColor('--outbound'));
  drawChart('pulse-chart', history.pulse, themeColor('--accent'));
}

function setWidth(id, percentage) {
  $(id).style.width = `${Math.min(100, Math.max(0, percentage))}%`;
}

function updateIdentity(snapshot) {
  $('identity-machine').textContent = snapshot.hostname;
  $('host-user').textContent = `USER ${snapshot.username}`;
  $('host-short').textContent = snapshot.hostname.toUpperCase();
  $('host-platform').textContent = snapshot.platform.toUpperCase();
  $('host-kernel').textContent = `KERNEL ${snapshot.kernel}`;
  $('footer-platform').textContent = `${snapshot.platform.toUpperCase()} / ${snapshot.kernel}`;
  $('settings-host').textContent = snapshot.hostname;
  $('settings-platform').textContent = snapshot.platform;
  $('settings-kernel').textContent = snapshot.kernel;
  applyPreferences();
}

function updateOverview(snapshot) {
  const rootDevice = [...new Map(snapshot.disks.map((disk) => [disk.device, disk])).values()];
  const maxDiskPercent = Math.max(0, ...rootDevice.map((disk) => disk.percent));
  const hottestCelsius = snapshot.temperatures[0]?.celsius ?? 0;
  const pulseScore = Math.round(Math.max(0, 100 - snapshot.cpu.percent * 0.32 - snapshot.memory.percent * 0.38 - maxDiskPercent * 0.2 - Math.max(0, hottestCelsius - 55) * 0.4));
  keepHistory('pulse', pulseScore);
  $('pulse-score').textContent = `${pulseScore}% · ${pulseScore >= 80 ? 'IN ORBIT' : pulseScore >= 60 ? 'UNDER LOAD' : 'NEEDS ATTENTION'}`;
  $('pulse-clock').textContent = new Date(snapshot.timestamp).toLocaleTimeString();
  $('now-metric').textContent = `${pulseScore}%`;
  $('now-caption').textContent = `System wellness · ${snapshot.cpu.percent.toFixed(1)}% processor load`;
  $('now-host').textContent = snapshot.hostname;
  $('now-user').textContent = `local user / ${snapshot.username}`;

  $('cpu-value').textContent = snapshot.cpu.percent.toFixed(1);
  $('cpu-cores').textContent = `${snapshot.cpu.cores} logical processors`;
  $('cpu-load').textContent = snapshot.cpu.loadAverage.map((value) => value.toFixed(2)).join(' / ');
  keepHistory('cpu', snapshot.cpu.percent);

  $('memory-value').textContent = snapshot.memory.percent.toFixed(1);
  $('memory-used').textContent = `${formatBytes(snapshot.memory.used)} used`;
  $('memory-available').textContent = `${formatBytes(snapshot.memory.available)} free`;
  $('memory-total').textContent = `${formatBytes(snapshot.memory.total)} total`;
  $('memory-state').textContent = snapshot.memory.percent >= 90 ? 'CRITICAL' : snapshot.memory.percent >= 75 ? 'ELEVATED' : 'NOMINAL';
  setWidth('memory-meter', snapshot.memory.percent);

  const hottest = snapshot.temperatures[0];
  const celsius = hottest?.celsius;
  const temperature = celsius === undefined ? undefined : preferences.temperatureUnit === 'F' ? celsius * 9 / 5 + 32 : celsius;
  $('temp-value').textContent = temperature === undefined ? '—' : temperature.toFixed(1);
  $('temp-unit').textContent = `°${preferences.temperatureUnit}`;
  $('temp-label').textContent = hottest?.name ?? (snapshot.platform === 'macOS' ? 'Not exposed by macOS without a sensor driver' : 'No readable sensor');
  $('temp-count').textContent = snapshot.temperatures.length ? `${snapshot.temperatures.length} SENSORS` : 'NO SENSOR DATA';
  $('temp-status').textContent = celsius === undefined ? 'N/A' : celsius >= 85 ? 'HIGH' : celsius >= 70 ? 'WARM' : 'NOMINAL';
  keepHistory('temperature', celsius ?? 0);

  $('uptime').textContent = `UP ${formatDuration(snapshot.uptimeSeconds)}`;
  $('uptime-long').textContent = formatDuration(snapshot.uptimeSeconds);
  $('uptime-days').textContent = `${Math.floor(snapshot.uptimeSeconds / 86400)}D`;
  $('system-time').textContent = new Date(snapshot.timestamp).toLocaleTimeString();
  $('updated-at').textContent = new Date(snapshot.timestamp).toLocaleTimeString();

  const interfaces = Object.entries(snapshot.network);
  const receive = interfaces.reduce((sum, [, value]) => sum + value.rxBytesPerSecond, 0);
  const transmit = interfaces.reduce((sum, [, value]) => sum + value.txBytesPerSecond, 0);
  $('network-rx').textContent = formatRate(receive);
  $('network-tx').textContent = formatRate(transmit);
  $('network-rx-total').textContent = `${formatBytes(interfaces.reduce((sum, [, item]) => sum + item.rxBytes, 0))} total`;
  $('network-tx-total').textContent = `${formatBytes(interfaces.reduce((sum, [, item]) => sum + item.txBytes, 0))} total`;
  keepHistory('receive', receive);
  keepHistory('transmit', transmit);
  recordSignals({
    cpu: snapshot.cpu.percent,
    memory: snapshot.memory.percent,
    disk: maxDiskPercent,
    temperature: snapshot.temperatures[0]?.celsius,
    network: receive + transmit,
    sensors: snapshot.temperatures.length
  });
  renderMiniInterfaces(interfaces);
  renderNetworkPage(snapshot);
  renderStorage(snapshot);
  latestProcesses = snapshot.processes;
  $('nav-process-count').textContent = String(latestProcesses.length);
  $('process-total').textContent = String(latestProcesses.length);
  renderProcesses();
  renderTopProcesses();
  drawCharts();
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderMiniInterfaces(interfaces) {
  const list = $('mini-interface-list');
  list.replaceChildren();
  for (const [name, value] of interfaces.slice(0, 4)) {
    const row = createElement('div', 'mini-interface');
    row.append(createElement('strong', '', name), createElement('span', '', `↓ ${formatRate(value.rxBytesPerSecond)}　↑ ${formatRate(value.txBytesPerSecond)}`));
    list.append(row);
  }
  if (!interfaces.length) list.append(createElement('p', 'empty-copy', 'No active interfaces were reported.'));
}

function renderTopProcesses() {
  const list = $('top-processes');
  list.replaceChildren();
  for (const process of latestProcesses.slice(0, 4)) {
    const row = createElement('button', 'top-process');
    row.type = 'button';
    const name = createElement('span', 'top-process-name', process.name);
    const pid = createElement('small', '', `PID ${process.pid}`);
    const cpu = createElement('strong', '', `${process.cpuPercent.toFixed(1)}%`);
    row.append(name, pid, cpu);
    row.addEventListener('click', () => {
      location.hash = '#/processes';
      selectedProcess = process;
      renderProcessDetail(process);
    });
    list.append(row);
  }
  if (!latestProcesses.length) list.append(createElement('p', 'empty-copy', 'Waiting for process data…'));
}

function renderProcesses() {
  const query = $('process-search').value.trim().toLowerCase();
  const state = $('process-state-filter').value;
  const filtered = latestProcesses.filter((process) =>
    (process.name.toLowerCase().includes(query) || String(process.pid).includes(query))
    && (state === 'all' || process.state.toLowerCase().startsWith(state))
  );
  filtered.sort((a, b) => {
    const left = a[sortKey];
    const right = b[sortKey];
    if (typeof left === 'string') return left.localeCompare(right) * sortDirection;
    return ((left ?? 0) - (right ?? 0)) * sortDirection;
  });
  const table = $('process-table');
  table.replaceChildren();
  for (const process of filtered.slice(0, 150)) {
    const row = table.insertRow();
    row.className = 'process-row';
    row.tabIndex = 0;
    row.setAttribute('aria-label', `Inspect process ${process.name}, PID ${process.pid}`);
    const values = [
      process.name,
      process.pid.toLocaleString(),
      process.state.toUpperCase(),
      `${process.cpuPercent.toFixed(1)}%`,
      formatBytes(process.rss),
      String(process.ppid)
    ];
    values.forEach((value, index) => {
      const cell = row.insertCell();
      cell.textContent = value;
      if (index === 0) cell.className = 'process-name-cell';
      if (index === 2) cell.className = `process-state state-${process.state.toLowerCase()[0]}`;
      if (index > 2) cell.classList.add('numeric-cell');
    });
    row.addEventListener('click', () => renderProcessDetail(process));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        renderProcessDetail(process);
      }
    });
  }
  if (!filtered.length) {
    const row = table.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 6;
    cell.className = 'empty';
    cell.textContent = 'No processes match these filters.';
  }
  $('process-range').textContent = `Showing ${Math.min(filtered.length, 150)} of ${filtered.length} matching processes`;
}

function renderProcessDetail(process) {
  selectedProcess = process;
  const panel = $('process-detail');
  panel.replaceChildren();
  const heading = createElement('div', 'detail-heading');
  const title = createElement('div');
  title.append(createElement('div', 'eyebrow', 'PROCESS DOSSIER'), createElement('h2', '', process.name));
  const close = createElement('button', 'detail-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Clear selected process');
  close.addEventListener('click', () => {
    selectedProcess = undefined;
    renderProcessDetail(undefined);
  });
  heading.append(title, close);
  panel.append(heading);
  if (!process) {
    panel.append(createElement('p', 'empty-copy', 'Select a row to inspect its local process metadata.'));
    return;
  }
  const fields = [
    ['PID', process.pid],
    ['Parent PID', process.ppid],
    ['State', process.state],
    ['CPU share', `${process.cpuPercent.toFixed(2)}%`],
    ['Resident memory', formatBytes(process.rss)]
  ];
  const grid = createElement('div', 'detail-grid');
  for (const [label, value] of fields) {
    const item = createElement('div', 'detail-field');
    item.append(createElement('small', '', label), createElement('strong', '', String(value)));
    grid.append(item);
  }
  panel.append(grid, createElement('p', 'detail-privacy', 'For privacy, this dashboard intentionally does not read process arguments, environment variables, or open files.'));
}

function renderNetworkPage(snapshot) {
  const entries = Object.entries(snapshot.network);
  const rxTotal = entries.reduce((sum, [, value]) => sum + value.rxBytesPerSecond, 0);
  const txTotal = entries.reduce((sum, [, value]) => sum + value.txBytesPerSecond, 0);
  $('network-count').textContent = String(entries.length);
  $('network-rx-large').textContent = formatRate(rxTotal);
  $('network-tx-large').textContent = formatRate(txTotal);
  $('network-rx-all').textContent = `${formatBytes(entries.reduce((sum, [, value]) => sum + value.rxBytes, 0))} received since boot`;
  $('network-tx-all').textContent = `${formatBytes(entries.reduce((sum, [, value]) => sum + value.txBytes, 0))} sent since boot`;
  const container = $('interface-cards');
  container.replaceChildren();
  const sortBy = $('network-sort').value;
  const sorted = [...entries].sort(([nameA, a], [nameB, b]) => sortBy === 'rx'
    ? b.rxBytesPerSecond - a.rxBytesPerSecond
    : sortBy === 'tx' ? b.txBytesPerSecond - a.txBytesPerSecond : nameA.localeCompare(nameB));
  for (const [name, value] of sorted) {
    const card = createElement('article', 'surface-panel interface-card');
    const title = createElement('div', 'interface-card-heading');
    const icon = createElement('span', 'interface-icon', '⌁');
    const nameBlock = createElement('div');
    nameBlock.append(createElement('strong', '', name), createElement('small', '', 'NETWORK INTERFACE'));
    title.append(icon, nameBlock, createElement('span', 'signal-status', '● ONLINE'));
    const rates = createElement('div', 'interface-rates');
    for (const [label, rate, total, className] of [
      ['INBOUND', value.rxBytesPerSecond, value.rxBytes, 'receive'],
      ['OUTBOUND', value.txBytesPerSecond, value.txBytes, 'transmit']
    ]) {
      const metric = createElement('div', `interface-rate ${className}`);
      metric.append(createElement('small', '', label), createElement('strong', '', formatRate(rate)), createElement('span', '', `${formatBytes(total)} total`));
      rates.append(metric);
    }
    card.append(title, rates);
    container.append(card);
  }
  if (!entries.length) container.append(createElement('p', 'empty-copy', 'No active network interfaces were reported.'));
}

function renderStorage(snapshot) {
  const disks = snapshot.disks;
  const uniqueDevices = [...new Map(disks.map((disk) => [disk.device, disk])).values()];
  const total = uniqueDevices.reduce((sum, disk) => sum + disk.total, 0);
  const used = uniqueDevices.reduce((sum, disk) => sum + disk.used, 0);
  const available = uniqueDevices.reduce((sum, disk) => sum + disk.available, 0);
  const percent = total ? used / total * 100 : 0;
  $('storage-count').textContent = String(disks.length);
  $('storage-aggregate').textContent = formatBytes(total);
  $('storage-aggregate-label').textContent = `${formatBytes(used)} used · ${formatBytes(available)} available`;
  $('storage-percent').textContent = `${percent.toFixed(1)}%`;
  $('storage-filesystem-count').textContent = `${uniqueDevices.length} unique devices · mount list below`;
  $('storage-donut-value').style.strokeDasharray = `${Math.min(295, percent / 100 * 295)} 295`;
  $('storage-donut-value').style.transform = 'rotate(-90deg)';

  const sortBy = $('storage-sort').value;
  const sorted = [...disks].sort((a, b) => sortBy === 'usage'
    ? b.percent - a.percent
    : sortBy === 'size' ? b.total - a.total : a.mountpoint.localeCompare(b.mountpoint));
  const cards = $('storage-cards');
  cards.replaceChildren();
  $('volume-preview').replaceChildren();
  sorted.forEach((disk, index) => {
    const card = createElement('article', 'surface-panel storage-card');
    const heading = createElement('div', 'storage-card-heading');
    heading.append(createElement('span', 'volume-index', `VOL / ${String(index + 1).padStart(2, '0')}`), createElement('span', 'filesystem-type', disk.type.toUpperCase()));
    const path = createElement('h3', '', disk.mountpoint);
    const device = createElement('p', 'device-label', disk.device);
    const meter = createElement('div', 'storage-meter');
    const fill = createElement('span', `storage-fill${disk.percent >= 90 ? ' warning' : ''}`);
    fill.style.width = `${Math.min(100, disk.percent)}%`;
    meter.append(fill);
    const stats = createElement('div', 'storage-card-stats');
    stats.append(createElement('strong', '', `${disk.percent.toFixed(1)}% used`), createElement('span', '', `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`));
    const space = createElement('small', 'available-label', `${formatBytes(disk.available)} available`);
    card.append(heading, path, device, meter, stats, space);
    cards.append(card);
    if (index < 4) {
      const preview = createElement('button', 'volume-strip');
      preview.type = 'button';
      preview.title = `${disk.mountpoint}: ${formatBytes(disk.available)} available`;
      preview.append(createElement('span', '', disk.mountpoint));
      const previewMeter = createElement('i');
      previewMeter.style.width = `${Math.min(100, disk.percent)}%`;
      preview.append(previewMeter, createElement('b', '', `${disk.percent.toFixed(0)}%`));
      preview.addEventListener('click', () => {
        location.hash = '#/storage';
        cards.querySelectorAll('.storage-card').forEach((item) => item.classList.remove('selected'));
        card.classList.add('selected');
      });
      $('volume-preview').append(preview);
    }
  });
  if (!disks.length) cards.append(createElement('p', 'empty-copy', 'No local mounted filesystems were reported.'));
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  updateIdentity(snapshot);
  if (livePaused) {
    $('connection-state').textContent = 'PAUSED · SNAPSHOT HELD';
    $('connection-dot').classList.add('connected');
    return;
  }
  updateOverview(snapshot);
  $('connection-state').textContent = 'LIVE · 1s';
  $('connection-dot').classList.add('connected');
}

function route() {
  const requested = location.hash.match(/^#\/(overview|processes|network|storage|settings)$/)?.[1] ?? 'overview';
  document.querySelectorAll('[data-page]').forEach((page) => {
    page.classList.toggle('active', page.dataset.page === requested);
  });
  document.querySelectorAll('[data-route]').forEach((link) => {
    const active = link.dataset.route === requested;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('page-crumb').textContent = requested.toUpperCase();
  document.title = `AETHER / ${requested[0].toUpperCase()}${requested.slice(1)} · Local Systems Observatory`;
  requestAnimationFrame(drawCharts);
  if (requested === 'processes') renderProcesses();
}

function setupInteractions() {
  $('process-search').addEventListener('input', renderProcesses);
  $('process-state-filter').addEventListener('change', renderProcesses);
  $('network-sort').addEventListener('change', () => latestSnapshot && renderNetworkPage(latestSnapshot));
  $('storage-sort').addEventListener('change', () => latestSnapshot && renderStorage(latestSnapshot));
  document.querySelectorAll('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      sortDirection = sortKey === key ? -sortDirection : key === 'name' || key === 'state' ? 1 : -1;
      sortKey = key;
      document.querySelectorAll('[data-sort]').forEach((item) => item.classList.toggle('sorted', item === button));
      renderProcesses();
    });
  });
  $('pause-live').addEventListener('click', () => {
    livePaused = !livePaused;
    $('pause-live').innerHTML = livePaused ? '<span>▶</span> Resume feed' : '<span>Ⅱ</span> Pause feed';
    $('connection-state').textContent = livePaused ? 'PAUSED · SNAPSHOT HELD' : 'LIVE · 1s';
  });
  $('open-profile').addEventListener('click', () => { location.hash = '#/settings'; });
  $('open-settings').addEventListener('click', () => { location.hash = '#/settings'; });
  $('open-command').addEventListener('click', openCommandPalette);
  $('command-search').addEventListener('input', () => {
    const query = $('command-search').value.toLowerCase();
    document.querySelectorAll('.command-item').forEach((item) => {
      item.hidden = !item.textContent.toLowerCase().includes(query);
    });
  });
  $('command-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') document.querySelector('.command-item:not([hidden])')?.click();
  });
  document.querySelectorAll('[data-command-route]').forEach((button) => {
    button.addEventListener('click', () => {
      location.hash = `#/${button.dataset.commandRoute}`;
      $('command-palette').close();
    });
  });
  $('command-theme').addEventListener('click', () => {
    $('command-palette').close();
    $('theme-cycle').click();
  });
  $('command-focus-process').addEventListener('click', () => {
    $('command-palette').close();
    location.hash = '#/processes';
    setTimeout(() => $('process-search').focus(), 0);
  });
  $('theme-cycle').addEventListener('click', () => {
    const choices = ['system', 'dark', 'light'];
    preferences.theme = choices[(choices.indexOf(preferences.theme) + 1) % choices.length];
    applyPreferences();
    persistPreferences();
  });
  $('theme-select').addEventListener('change', () => {
    preferences.theme = $('theme-select').value;
    applyPreferences();
  });
  $('temperature-unit').addEventListener('change', () => {
    preferences.temperatureUnit = $('temperature-unit').value;
    if (latestSnapshot) renderTemperature(latestSnapshot);
  });
  $('density-select').addEventListener('change', () => {
    preferences.density = $('density-select').value;
    applyPreferences();
  });
  $('display-name').addEventListener('input', () => {
    preferences.name = $('display-name').value.trim().slice(0, 32);
    applyPreferences();
  });
  $('save-preferences').addEventListener('click', persistPreferences);
  document.querySelectorAll('[data-accent-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      preferences.accent = button.dataset.accentChoice;
      applyPreferences();
      drawCharts();
    });
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', drawCharts);
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault();
      location.hash = '#/settings';
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      location.hash = '#/processes';
      setTimeout(() => $('process-search').focus(), 0);
    }
  });
}

function openCommandPalette() {
  const palette = $('command-palette');
  if (!palette.open) palette.showModal();
  $('command-search').value = '';
  document.querySelectorAll('.command-item').forEach((item) => { item.hidden = false; });
  $('command-search').focus();
}

function renderTemperature(snapshot) {
  const celsius = snapshot.temperatures[0]?.celsius;
  $('temp-unit').textContent = `°${preferences.temperatureUnit}`;
  if (celsius !== undefined) $('temp-value').textContent = (preferences.temperatureUnit === 'F' ? celsius * 9 / 5 + 32 : celsius).toFixed(1);
}

$('current-date').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date());
setupInteractions();
applyPreferences();
if (!location.hash) location.hash = '#/overview';
route();

const stream = new EventSource('/api/events');
stream.onmessage = (event) => {
  try {
    const snapshot = JSON.parse(event.data);
    renderSnapshot(snapshot);
  } catch {
    $('connection-state').textContent = 'INVALID TELEMETRY';
    $('connection-dot').classList.remove('connected');
  }
};
stream.onerror = () => {
  $('connection-state').textContent = 'RECONNECTING…';
  $('connection-dot').classList.remove('connected');
};
