import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCpuStat,
  parseDarwinDisks,
  parseDarwinNetwork,
  parseDarwinProcesses,
  parseMemInfo,
  parseNetwork,
  parseProcStat
} from '../metrics.mjs';

test('parses aggregate CPU counters, includes idle I/O and excludes guest double-counting', () => {
  assert.deepEqual(parseCpuStat('cpu  100 2 30 400 8 1 3 0 50 10\ncpu0 1'), {
    total: 544,
    idle: 408
  });
});

test('rejects missing CPU counters', () => {
  assert.throws(() => parseCpuStat('cpu0 1 2 3'), /unavailable/);
});

test('uses MemAvailable to compute used memory', () => {
  assert.deepEqual(parseMemInfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\n'), {
    total: 1024000,
    used: 768000,
    available: 256000,
    percent: 75
  });
});

test('parses process names containing spaces and closing parentheses', () => {
  const fields = ['S', '1', '1', '0', '-1', '0', '0', '0', '0', '0', '12', '8', '0', '0', '0', '0', '20', '0', '1', '0', '987', '42'];
  const process = parseProcStat(`321 (worker ) pool) ${fields.join(' ')}`);
  assert.equal(process.name, 'worker ) pool');
  assert.equal(process.ppid, 1);
  assert.equal(process.cpuTicks, 8);
  assert.equal(process.rssPages, 42);
});

test('ignores loopback and parses network receive/transmit counters', () => {
  const network = parseNetwork([
    'Inter-| Receive | Transmit',
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
    '    lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
    '  eth0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0'
  ].join('\n'));
  assert.deepEqual(network, { eth0: { rxBytes: 300, txBytes: 400 } });
});

test('parses macOS network counters and ignores duplicate address rows', () => {
  const network = parseDarwinNetwork([
    'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll',
    'en0 1500 <Link#4> aa:bb:cc 10 0 1000 12 0 1200 0',
    'en0 1500 inet 192.0.2.2 10 0 900 12 0 1100 0',
    'lo0 16384 <Link#1> 1 0 10 1 0 10 0'
  ].join('\n'));
  assert.deepEqual(network, { en0: { rxBytes: 1000, txBytes: 1200 } });
});

test('parses macOS process records with executable paths', () => {
  const processes = parseDarwinProcesses(
    '  42   1 S+   12.5 2048 /Applications/Studio App.app/Contents/MacOS/Studio'
  );
  assert.deepEqual(processes, [{
    pid: 42,
    ppid: 1,
    state: 'S',
    cpuPercent: 12.5,
    rss: 2097152,
    name: '/Applications/Studio App.app/Contents/MacOS/Studio'
  }]);
});

test('parses macOS disk capacity records and skips synthetic volumes', () => {
  const disks = parseDarwinDisks([
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/disk3s1 100000 25000 75000 25% /System/Volumes/Data',
    'map auto_home 0 0 0 100% /System/Volumes/Data/home'
  ].join('\n'));
  assert.deepEqual(disks, [{
    device: '/dev/disk3s1',
    mountpoint: '/System/Volumes/Data',
    type: 'apfs',
    total: 102400000,
    used: 25600000,
    available: 76800000,
    percent: 25
  }]);
});
