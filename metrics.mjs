import { readdir, readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os, { userInfo } from 'node:os';

const execFileAsync = promisify(execFile);
const PROC = '/proc';
const SYS_THERMAL = '/sys/class/thermal';
const SYS_HWMON = '/sys/class/hwmon';

function localIdentity() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || 'local-user';
  }
}

export function parseCpuStat(text) {
  const line = text.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) throw new Error('CPU counters are unavailable in /proc/stat');
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('CPU counters in /proc/stat are invalid');
  }
  return {
    total: values.slice(0, 8).reduce((sum, value) => sum + value, 0),
    idle: values[3] + (values[4] ?? 0)
  };
}

export function parseMemInfo(text) {
  const values = new Map(
    text.split('\n').flatMap((line) => {
      const match = line.match(/^([^:]+):\s+(\d+)\s+kB$/);
      return match ? [[match[1], Number(match[2]) * 1024]] : [];
    })
  );
  const total = values.get('MemTotal');
  const available = values.get('MemAvailable');
  if (!total || available === undefined) {
    throw new Error('Memory totals are unavailable in /proc/meminfo');
  }
  const used = Math.max(0, total - available);
  return { total, used, available, percent: (used / total) * 100 };
}

export function parseProcStat(text) {
  const closeParen = text.lastIndexOf(')');
  const openParen = text.indexOf('(');
  if (openParen < 0 || closeParen <= openParen) {
    throw new Error('Process stat entry is malformed');
  }
  const fields = text.slice(closeParen + 1).trim().split(/\s+/);
  if (fields.length < 22) throw new Error('Process stat entry is incomplete');
  return {
    name: text.slice(openParen + 1, closeParen),
    state: fields[0],
    ppid: Number(fields[1]),
    cpuTicks: Number(fields[11]) + Number(fields[12]),
    rssPages: Number(fields[21])
  };
}

export function parseNetwork(text) {
  const interfaces = {};
  for (const line of text.split('\n').slice(2)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    if (!name || name === 'lo') continue;
    const counters = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    if (counters.length < 9 || counters.some((value) => !Number.isFinite(value))) continue;
    interfaces[name] = { rxBytes: counters[0], txBytes: counters[8] };
  }
  return interfaces;
}

function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function parseMounts(text) {
  const mounts = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 3) continue;
    const device = decodeMountField(fields[0]);
    const mountpoint = decodeMountField(fields[1]);
    const type = fields[2];
    if ((!device.startsWith('/dev/') && mountpoint !== '/') || seen.has(mountpoint)) continue;
    seen.add(mountpoint);
    mounts.push({ device, mountpoint, type });
  }
  return mounts;
}

async function collectDisks() {
  const mounts = parseMounts(await readFile(`${PROC}/mounts`, 'utf8'));
  const disks = await Promise.all(mounts.map(async ({ device, mountpoint, type }) => {
    try {
      const stats = await statfs(mountpoint);
      const total = stats.blocks * stats.bsize;
      const available = stats.bavail * stats.bsize;
      const used = Math.max(0, total - stats.bfree * stats.bsize);
      if (!Number.isFinite(total) || total <= 0) return null;
      return {
        device,
        mountpoint,
        type,
        total,
        used,
        available,
        percent: (used / total) * 100
      };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENODEV') return null;
      throw error;
    }
  }));
  return disks.filter(Boolean).sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
}

async function collectTemperatures() {
  const sensors = [];
  const readSensor = async (path, name) => {
    try {
      const raw = Number((await readFile(path, 'utf8')).trim());
      if (!Number.isFinite(raw)) return;
      const celsius = Math.abs(raw) > 1000 ? raw / 1000 : raw;
      if (celsius >= -40 && celsius <= 150) sensors.push({ name, celsius });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENXIO', 'ENODEV', 'EIO'].includes(error.code)) throw error;
    }
  };

  for (const [root, pattern] of [[SYS_THERMAL, /^thermal_zone\d+$/], [SYS_HWMON, /^hwmon\d+$/]]) {
    let entries;
    try {
      entries = await readdir(root);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue;
      throw error;
    }
    await Promise.all(entries.filter((entry) => pattern.test(entry)).map(async (entry) => {
      const directory = `${root}/${entry}`;
      if (root === SYS_THERMAL) {
        let name = entry;
        try {
          name = (await readFile(`${directory}/type`, 'utf8')).trim() || entry;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
        }
        await readSensor(`${directory}/temp`, name);
        return;
      }
      let names;
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES') return;
        throw error;
      }
      await Promise.all(names.filter((name) => /^temp\d+_input$/.test(name)).map(async (filename) => {
        const index = filename.match(/^temp(\d+)_input$/)?.[1];
        let label = `${entry} temp${index}`;
        try {
          label = (await readFile(`${directory}/temp${index}_label`, 'utf8')).trim() || label;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
        }
        await readSensor(`${directory}/${filename}`, label);
      }));
    }));
  }
  return sensors.sort((a, b) => b.celsius - a.celsius);
}

async function collectProcesses(previousTicks, totalTicksDelta, cpuCount) {
  const entries = await readdir(PROC, { withFileTypes: true });
  const processes = [];
  const nextTicks = new Map();
  const candidates = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
  let next = 0;
  const readWorker = async () => {
    while (next < candidates.length) {
      const entry = candidates[next++];
      const pid = Number(entry.name);
      try {
        const [statText, statusText] = await Promise.all([
          readFile(`${PROC}/${entry.name}/stat`, 'utf8'),
          readFile(`${PROC}/${entry.name}/status`, 'utf8')
        ]);
        const stat = parseProcStat(statText);
        nextTicks.set(pid, stat.cpuTicks);
        const rss = Number(statusText.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024;
        const previous = previousTicks.get(pid);
        const cpuPercent = previous !== undefined && totalTicksDelta > 0
          ? Math.max(0, ((stat.cpuTicks - previous) / totalTicksDelta) * cpuCount * 100)
          : 0;
        processes.push({ pid, name: stat.name, state: stat.state, ppid: stat.ppid, rss, cpuPercent });
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH' && error.code !== 'EACCES') throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, candidates.length) }, readWorker));
  processes.sort((a, b) => b.cpuPercent - a.cpuPercent || b.rss - a.rss);
  return { processes, nextTicks };
}

function createLinuxMetricsCollector() {
  let previousCpu;
  let previousNetwork = {};
  let previousProcesses = new Map();
  let previousTime;
  const cpuCount = Math.max(1, os.cpus().length);

  return async function snapshot() {
    const [cpuText, memText, networkText, disks, temperatures] = await Promise.all([
      readFile(`${PROC}/stat`, 'utf8'),
      readFile(`${PROC}/meminfo`, 'utf8'),
      readFile(`${PROC}/net/dev`, 'utf8'),
      collectDisks(),
      collectTemperatures()
    ]);
    const now = Date.now();
    const cpuCounters = parseCpuStat(cpuText);
    const elapsed = previousTime === undefined ? 0 : Math.max(0.001, (now - previousTime) / 1000);
    const totalTicksDelta = previousCpu ? cpuCounters.total - previousCpu.total : 0;
    const idleDelta = previousCpu ? cpuCounters.idle - previousCpu.idle : 0;
    const cpuPercent = totalTicksDelta > 0
      ? Math.min(100, Math.max(0, ((totalTicksDelta - idleDelta) / totalTicksDelta) * 100))
      : 0;

    const networkCounters = parseNetwork(networkText);
    const network = Object.fromEntries(Object.entries(networkCounters).map(([name, counters]) => {
      const previous = previousNetwork[name];
      return [name, {
        ...counters,
        rxBytesPerSecond: previous && elapsed > 0 ? Math.max(0, (counters.rxBytes - previous.rxBytes) / elapsed) : 0,
        txBytesPerSecond: previous && elapsed > 0 ? Math.max(0, (counters.txBytes - previous.txBytes) / elapsed) : 0
      }];
    }));
    const { processes, nextTicks } = await collectProcesses(previousProcesses, totalTicksDelta, cpuCount);
    previousCpu = cpuCounters;
    previousNetwork = networkCounters;
    previousProcesses = nextTicks;
    previousTime = now;

    return {
      timestamp: new Date(now).toISOString(),
      hostname: os.hostname(),
      username: localIdentity(),
      platform: 'Linux',
      kernel: os.release(),
      uptimeSeconds: os.uptime(),
      cpu: { percent: cpuPercent, cores: cpuCount, loadAverage: os.loadavg() },
      memory: parseMemInfo(memText),
      disks,
      temperatures,
      network,
      processes
    };
  };
}

export function parseDarwinNetwork(text) {
  const lines = text.trim().split('\n');
  const header = lines.find((line) => /\bIbytes\b/.test(line));
  if (!header) return {};
  const columns = header.trim().split(/\s+/);
  const rxIndex = columns.indexOf('Ibytes');
  const txIndex = columns.indexOf('Obytes');
  const nameIndex = columns.indexOf('Name');
  if (rxIndex < 0 || txIndex < 0 || nameIndex < 0) return {};
  const interfaces = {};
  for (const line of lines.slice(lines.indexOf(header) + 1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length <= Math.max(rxIndex, txIndex, nameIndex)) continue;
    const name = fields[nameIndex];
    const rxBytes = Number(fields[rxIndex]);
    const txBytes = Number(fields[txIndex]);
    if (!name || name === 'lo0' || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    const previous = interfaces[name];
    interfaces[name] = {
      rxBytes: Math.max(previous?.rxBytes ?? 0, rxBytes),
      txBytes: Math.max(previous?.txBytes ?? 0, txBytes)
    };
  }
  return interfaces;
}

export function parseDarwinProcesses(text) {
  return text.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const [, pid, ppid, state, cpu, rss, name] = match;
    return [{
      pid: Number(pid),
      ppid: Number(ppid),
      state: state[0],
      cpuPercent: Number(cpu),
      rss: Number(rss) * 1024,
      name
    }];
  });
}

export function parseDarwinDisks(text) {
  return text.split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !fields[0].startsWith('/dev/')) return [];
    const total = Number(fields[1]) * 1024;
    const used = Number(fields[2]) * 1024;
    const available = Number(fields[3]) * 1024;
    if (!Number.isFinite(total) || total <= 0) return [];
    return [{
      device: fields[0],
      mountpoint: fields.slice(5).join(' '),
      type: 'apfs',
      total,
      used,
      available,
      percent: (used / total) * 100
    }];
  }).sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
}

async function runSystemCommand(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

async function collectDarwinMemory() {
  const output = await runSystemCommand('/usr/bin/vm_stat', []);
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error('Unable to read macOS VM page size');
  const pages = (label) => Number(output.match(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
  const available = (pages('free') + pages('inactive') + pages('speculative')) * pageSize;
  const total = os.totalmem();
  const used = Math.max(0, total - available);
  return { total, used, available, percent: (used / total) * 100 };
}

async function collectDarwinDisks() {
  const output = await runSystemCommand('/bin/df', ['-Pk']);
  return parseDarwinDisks(output);
}

function createDarwinMetricsCollector() {
  let previousCpu;
  let previousNetwork = {};
  let previousTime;
  const cpuCount = Math.max(1, os.cpus().length);

  return async function snapshot() {
    const [disks, memory, networkText, processText] = await Promise.all([
      collectDarwinDisks(),
      collectDarwinMemory(),
      runSystemCommand('/usr/sbin/netstat', ['-ibn']),
      runSystemCommand('/bin/ps', ['-axo', 'pid=,ppid=,state=,%cpu=,rss=,comm='])
    ]);
    const now = Date.now();
    const cpuTimes = os.cpus().reduce((totals, cpu) => ({
      total: totals.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
      idle: totals.idle + cpu.times.idle
    }), { total: 0, idle: 0 });
    const totalDelta = previousCpu ? cpuTimes.total - previousCpu.total : 0;
    const idleDelta = previousCpu ? cpuTimes.idle - previousCpu.idle : 0;
    const cpuPercent = totalDelta > 0
      ? Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100))
      : 0;
    const elapsed = previousTime === undefined ? 0 : Math.max(0.001, (now - previousTime) / 1000);
    const counters = parseDarwinNetwork(networkText);
    const network = Object.fromEntries(Object.entries(counters).map(([name, value]) => {
      const previous = previousNetwork[name];
      return [name, {
        ...value,
        rxBytesPerSecond: previous ? Math.max(0, (value.rxBytes - previous.rxBytes) / elapsed) : 0,
        txBytesPerSecond: previous ? Math.max(0, (value.txBytes - previous.txBytes) / elapsed) : 0
      }];
    }));
    const processes = parseDarwinProcesses(processText)
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rss - a.rss);
    previousCpu = cpuTimes;
    previousNetwork = counters;
    previousTime = now;
    return {
      timestamp: new Date(now).toISOString(),
      hostname: os.hostname(),
      username: localIdentity(),
      platform: 'macOS',
      kernel: os.release(),
      uptimeSeconds: os.uptime(),
      cpu: { percent: cpuPercent, cores: cpuCount, loadAverage: os.loadavg() },
      memory,
      disks,
      temperatures: [],
      network,
      processes
    };
  };
}

export function createMetricsCollector() {
  if (process.platform === 'linux') return createLinuxMetricsCollector();
  if (process.platform === 'darwin') return createDarwinMetricsCollector();
  throw new Error(`Unsupported platform: ${process.platform}. Supported platforms are Linux and macOS.`);
}
