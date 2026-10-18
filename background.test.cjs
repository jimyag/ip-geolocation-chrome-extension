const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(fetch, executeScript = async () => {}) {
  const store = {}, notifications = [], requests = [], timers = new Map();
  let onMessage;
  const event = { addListener() {} };
  let tabUpdated, tabActivated;
  const tabRows = [{ id: 1, url: 'https://example.com', status: 'complete' }, { id: 2, url: 'chrome://extensions/', status: 'complete' }];
  const context = vm.createContext({
    console: { log() {}, error() {} }, AbortSignal,
    setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { requests.push(url); return fetch(url, options); },
    chrome: {
      storage: { local: {
        async get() { return structuredClone(store); },
        async set(values) { Object.assign(store, structuredClone(values)); },
        async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
      } },
      tabs: {
        onUpdated: { addListener(listener) { tabUpdated = listener; } },
        onActivated: { addListener(listener) { tabActivated = listener; } },
        async query() { return structuredClone(tabRows); },
        async get(id) { const tab = tabRows.find(tab => tab.id === id); if (!tab) throw new Error(`No tab with id: ${id}`); return structuredClone(tab); }
      },
      scripting: { executeScript },
      alarms: { onAlarm: event, create() {} },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      notifications: { async create(id, data) { notifications.push(data); }, async clear() {} },
      runtime: { getURL: name => name, onInstalled: event, onStartup: event,
        onMessage: { addListener(listener) { onMessage = listener; } } }
    }
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/background.js`, 'utf8'), context);
  const send = request => new Promise(resolve => { onMessage(request, {}, resolve); });
  return { store, notifications, requests, send, tabRows,
    tabUpdated: (...args) => tabUpdated?.(...args), tabActivated: (...args) => tabActivated?.(...args),
    storage: context.chrome.storage.local, notificationApi: context.chrome.notifications,
    refresh: () => send({ action: 'manualUpdate' }),
    fireTimeouts() { for (const callback of timers.values()) callback(); timers.clear(); } };
}

const good = { ip: '58.30.0.0', country_code: 'CN', latitude: 39.93, longitude: 116.41 };
const response = data => ({ ok: true, json: async () => data });

test('switches past network and invalid data, adapts ip9 and injects exact cached coordinates', async () => {
  const injected = [];
  const app = setup(async url => {
    if (url.includes('ipwho')) throw new Error('DNS failure');
    if (url.includes('ip.sb')) return response({ ...good, latitude: null });
    return response({ ret: 200, data: { ip: good.ip, country_code: 'cn', lat: '39.93', lng: '116.41' } });
  }, async options => { injected.push(options.args); });
  assert.equal((await app.refresh()).ok, true);
  assert.equal(app.requests.length, 3);
  assert.equal(app.store.ipInfo.latitude, 39.93);
  assert.equal(app.store.ipInfo.ip, good.ip);
  assert.equal(app.store.lastLocation.latitude, 39.93);
  assert.equal(app.store.lastLocation.longitude, 116.41);
  assert.deepEqual(Array.from(injected[0]), [39.93, 116.41]);
  assert.equal(app.store.health.state, 'backup');
  await app.refresh();
  assert.equal(app.notifications.length, 1);
});

test('persistent failures keep cache and details without repeating notifications', async () => {
  let offline = false;
  const app = setup(async () => { if (offline) throw new Error('offline'); return response(good); });
  await app.refresh();
  const cached = structuredClone(app.store.ipInfo);
  offline = true;
  assert.equal((await app.refresh()).ok, false);
  assert.deepEqual(app.store.ipInfo, cached);
  assert.equal(app.store.health.state, 'error');
  await app.refresh();
  assert.equal(app.notifications.length, 1);
  offline = false;
  assert.equal((await app.refresh()).ok, true);
  assert.equal(app.store.health.state, 'ok');
  assert.equal(app.store.lastError, undefined);
});

test('HTTP, malformed JSON and out-of-range coordinates fail explicitly without inventing a cache', async () => {
  const app = setup(async url => {
    if (url.includes('ipwho')) return { ok: false, status: 429 };
    if (url.includes('ip.sb')) return { ok: true, json: async () => { throw new Error('bad JSON'); } };
    return response({ ...good, latitude: 91 });
  });
  const result = await app.refresh();
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 429/);
  assert.match(result.error, /bad JSON/);
  assert.equal(app.store.lastLocation, undefined);
});

test('concurrent refreshes share one request and complete despite a hanging tab injection', async () => {
  let release;
  const app = setup(() => new Promise(resolve => { release = () => resolve(response(good)); }), () => new Promise(() => {}));
  const first = app.refresh(), second = app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(app.requests.length, 1);
});

test('old privacy cache is replaced by original API coordinates even while offline', async () => {
  const injected = [];
  const app = setup(async () => { throw new Error('offline'); }, async options => { injected.push(options.args); });
  app.store.ipInfo = { ...good, country: 'CN', source: 'https://ipwho.is/' };
  app.store.lastLocation = { latitude: 0, longitude: 0, country: '中国 (隐私保护)' };
  await app.refresh();
  assert.equal(app.store.lastLocation.latitude, good.latitude);
  assert.equal(app.store.lastLocation.longitude, good.longitude);
  assert.deepEqual(Array.from(injected[0]), [good.latitude, good.longitude]);
});

test('non-CN coordinates remain intact and failure can notify again after recovery', async () => {
  let fail = false;
  const app = setup(async () => {
    if (fail) throw new Error('offline');
    return response({ ...good, country_code: 'US', latitude: 39.15, longitude: -75.52 });
  });
  await app.refresh();
  assert.equal(app.store.lastLocation.latitude, 39.15);
  assert.equal(app.store.lastLocation.longitude, -75.52);
  fail = true;
  await app.refresh();
  fail = false;
  await app.refresh();
  app.store.lastNotificationAt = Date.now() - 5 * 60 * 1000 - 1;
  fail = true;
  await app.refresh();
  assert.equal(app.notifications.length, 2);
});

test('manual coordinates take priority, persist across refreshes, and automatic mode can be restored', async () => {
  const injected = [];
  const app = setup(async () => response(good), async options => { injected.push(options); });
  await app.refresh();
  const cache = structuredClone(app.store.ipInfo);
  assert.equal((await app.send({ action: 'setManualLocation', latitude: -12.5, longitude: 170 })).ok, true);
  await app.refresh();
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.store.ipInfo, cache);
  assert.equal(app.store.manualLocation.latitude, -12.5);
  assert.deepEqual(Array.from(injected.at(-1).args), [-12.5, 170]);
  assert.equal(injected.some(options => options.target.tabId === 2), false);
  await app.send({ action: 'useAutomaticLocation' });
  assert.equal(app.store.manualLocation, undefined);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(Array.from(injected.at(-1).args), [good.latitude, good.longitude]);
});

test('invalid manual input notifies and does not replace the current setting', async () => {
  const app = setup(async () => response(good));
  await app.send({ action: 'setManualLocation', latitude: 90, longitude: -180 });
  for (const latitude of [91, null, '', NaN]) {
    assert.equal((await app.send({ action: 'setManualLocation', latitude, longitude: 0 })).ok, false);
  }
  assert.equal(app.store.manualLocation.latitude, 90);
  assert.equal(app.notifications.length, 1);
  assert.equal(app.notifications.every(item => item.requireInteraction), true);
});

test('injection failure and timeout each produce a persistent failure alert', async () => {
  const failed = setup(async () => response(good), async () => { throw new Error('frame failed'); });
  await failed.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(failed.store.lastFailure.message, /更新网页位置失败.*frame failed/);
  assert.equal(failed.notifications.length, 1);
  const hanging = setup(async () => response(good), () => new Promise(() => {}));
  await hanging.refresh();
  hanging.fireTimeouts();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(hanging.store.lastFailure.message, /超过 8 秒/);
  assert.equal(hanging.notifications.length, 1);
});

test('failure to save updated location notifies with the actual error', async () => {
  const app = setup(async () => response(good));
  const save = app.storage.set;
  app.storage.set = async values => {
    if (values.ipInfo) throw new Error('storage quota exceeded');
    return save(values);
  };
  assert.equal((await app.refresh()).ok, false);
  assert.match(app.store.lastFailure.message, /storage quota exceeded/);
  assert.equal(app.notifications.length, 1);
});

test('notification API failure stays visible and acknowledgement cannot dismiss a newer failure', async () => {
  const app = setup(async () => { throw new Error('offline'); });
  app.notificationApi.create = async () => { throw new Error('notifications disabled'); };
  await app.refresh();
  assert.equal(app.store.notificationError, 'notifications disabled');
  const id = app.store.lastFailure.id;
  await app.send({ action: 'dismissFailure', id: 'old-error' });
  assert.equal(app.store.lastFailure.id, id);
  await app.send({ action: 'dismissFailure', id });
  assert.equal(app.store.lastFailure, undefined);
  assert.equal(app.store.notificationError, undefined);
});

test('defers frozen, unloaded and discarded tabs until they resume or load', async () => {
  const injected = [];
  const app = setup(async () => response(good), async options => { injected.push(options.target.tabId); });
  app.tabRows.push(
    {id: 3, url: 'https://frozen.example', status: 'complete', frozen: true},
    {id: 4, url: 'https://unloaded.example', status: 'unloaded'},
    {id: 5, url: 'https://discarded.example', status: 'complete', discarded: true}
  );
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(injected, [1]);
  app.tabRows[2].frozen = false;
  app.tabUpdated(3, {frozen: false}, app.tabRows[2]);
  app.tabRows[3].status = 'complete';
  app.tabUpdated(4, {status: 'complete'}, app.tabRows[3]);
  app.tabRows[4].discarded = false;
  app.tabActivated({tabId: 5});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(injected.sort(), [1,3,4,5]);
  assert.equal(app.notifications.length, 0);
});

test('browser error documents are skipped but genuine access failures still notify', async () => {
  const app = setup(async () => response(good), async () => { throw new Error('Frame with ID 0 is showing error page'); });
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.notifications.length, 0);
  const denied = setup(async () => response(good), async () => { throw new Error('Cannot access contents of the page'); });
  await denied.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(denied.notifications.length, 1);
});

test('cooldown combines different failures, and an ongoing failure stays quiet after cooldown', async () => {
  const app = setup(async () => { throw new Error('offline'); });
  await app.refresh();
  const id = app.store.lastFailure.id;
  assert.equal(app.notifications.length, 1);
  await app.send({ action: 'setManualLocation', latitude: 100, longitude: 0 });
  assert.equal(app.notifications.length, 1);
  assert.equal(app.store.lastFailure.id, id);
  app.store.lastNotificationAt = Date.now() - 5 * 60 * 1000 - 1;
  await app.refresh();
  assert.equal(app.notifications.length, 1);
  await app.send({ action: 'dismissFailure', id });
  await app.refresh();
  assert.equal(app.store.lastFailure, undefined);
  assert.equal(app.notifications.length, 1);
});
