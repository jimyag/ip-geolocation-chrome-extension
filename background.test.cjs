const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(fetch, executeScript = async () => {}) {
  const store = {}, notifications = [], requests = [], timers = new Map();
  let onMessage;
  let tabUpdated, tabActivated, installed, startup, alarm;
  const alarms = [];
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
      alarms: { onAlarm: { addListener(listener) { alarm = listener; } }, create(name, options) { alarms.push({ name, ...options }); } },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      notifications: { async create(id, data) { notifications.push(data); }, async clear() {} },
      runtime: { getURL: name => name,
        onInstalled: { addListener(listener) { installed = listener; } },
        onStartup: { addListener(listener) { startup = listener; } },
        onMessage: { addListener(listener) { onMessage = listener; } } }
    }
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/background.js`, 'utf8'), context);
  const send = request => new Promise(resolve => { onMessage(request, {}, resolve); });
  return { store, notifications, requests, send, tabRows, alarms,
    installed: () => installed(), startup: () => startup(), alarm: name => alarm({ name }),
    tabUpdated: (...args) => tabUpdated?.(...args), tabActivated: (...args) => tabActivated?.(...args),
    storage: context.chrome.storage.local,
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
  assert.equal(app.notifications.length, 0);
});

test('persistent failures keep cache and details without system notifications', async () => {
  let offline = false;
  const app = setup(async () => { if (offline) throw new Error('offline'); return response(good); });
  await app.refresh();
  const cached = structuredClone(app.store.ipInfo);
  offline = true;
  assert.equal((await app.refresh()).ok, false);
  assert.deepEqual(app.store.ipInfo, cached);
  assert.equal(app.store.health.state, 'error');
  await app.refresh();
  assert.equal(app.notifications.length, 0);
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

test('non-CN coordinates remain intact and recurring failures stay in the extension', async () => {
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
  fail = true;
  await app.refresh();
  assert.match(app.store.lastFailure.message, /offline/);
  assert.equal(app.notifications.length, 0);
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

test('invalid manual input records an error and does not replace the current setting', async () => {
  const app = setup(async () => response(good));
  await app.send({ action: 'setManualLocation', latitude: 90, longitude: -180 });
  for (const latitude of [91, null, '', NaN]) {
    assert.equal((await app.send({ action: 'setManualLocation', latitude, longitude: 0 })).ok, false);
  }
  assert.equal(app.store.manualLocation.latitude, 90);
  assert.match(app.store.lastFailure.message, /纬度须为/);
  assert.equal(app.notifications.length, 0);
});

test('injection failure and timeout each record persistent failure details', async () => {
  const failed = setup(async () => response(good), async () => { throw new Error('frame failed'); });
  await failed.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(failed.store.lastFailure.message, /更新网页位置失败.*frame failed/);
  assert.equal(failed.notifications.length, 0);
  const hanging = setup(async () => response(good), () => new Promise(() => {}));
  await hanging.refresh();
  hanging.fireTimeouts();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(hanging.store.lastFailure.message, /超过 8 秒/);
  assert.equal(hanging.notifications.length, 0);
});

test('failure to save updated location records the actual error', async () => {
  const app = setup(async () => response(good));
  const save = app.storage.set;
  app.storage.set = async values => {
    if (values.ipInfo) throw new Error('storage quota exceeded');
    return save(values);
  };
  assert.equal((await app.refresh()).ok, false);
  assert.match(app.store.lastFailure.message, /storage quota exceeded/);
  assert.equal(app.notifications.length, 0);
});

test('acknowledgement cannot dismiss a newer failure', async () => {
  const app = setup(async () => { throw new Error('offline'); });
  await app.refresh();
  const id = app.store.lastFailure.id;
  await app.send({ action: 'dismissFailure', id: 'old-error' });
  assert.equal(app.store.lastFailure.id, id);
  await app.send({ action: 'dismissFailure', id });
  assert.equal(app.store.lastFailure, undefined);
  assert.equal(app.notifications.length, 0);
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

test('browser error documents are skipped but genuine access failures are recorded', async () => {
  const app = setup(async () => response(good), async () => { throw new Error('Frame with ID 0 is showing error page'); });
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.notifications.length, 0);
  const denied = setup(async () => response(good), async () => { throw new Error('Cannot access contents of the page'); });
  await denied.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(denied.store.lastFailure.message, /Cannot access contents/);
  assert.equal(denied.notifications.length, 0);
});

test('failures remain available for acknowledgement and an acknowledged ongoing failure stays quiet', async () => {
  const app = setup(async () => { throw new Error('offline'); });
  await app.refresh();
  const id = app.store.lastFailure.id;
  assert.equal(app.notifications.length, 0);
  await app.send({ action: 'setManualLocation', latitude: 100, longitude: 0 });
  assert.equal(app.notifications.length, 0);
  assert.equal(app.store.lastFailure.id, id);
  await app.refresh();
  assert.equal(app.notifications.length, 0);
  await app.send({ action: 'dismissFailure', id });
  await app.refresh();
  assert.equal(app.store.lastFailure, undefined);
  assert.equal(app.notifications.length, 0);
});

test('Google refresh clicks only China-related footers after spoofing, with cooldown and coordinate changes', async () => {
  let text = 'China - From your IP address', label = 'Update location', clicks = 0, now = 1000000;
  let hasFooter = true, hasButton = true;
  const page = vm.createContext({
    Date: { now: () => now },
    navigator: { geolocation: {} },
    document: { querySelector() {
      return hasFooter ? { innerText: text, querySelectorAll() {
        return hasButton ? [{ innerText: label, textContent: 'Update locationCan\'t update your locationLearn moreUpdating location...', click() {
          page.navigator.geolocation.getCurrentPosition(position => {
            const expected = app.store.manualLocation || app.store.lastLocation;
            assert.equal(position.coords.latitude, expected.latitude);
            assert.equal(position.coords.longitude, expected.longitude);
          });
          clicks++;
        } }] : [];
      } } : null;
    } }
  });
  const injections = [];
  const app = setup(async () => response(good), async options => {
    injections.push(options.world);
    vm.runInContext(`(${options.func.toString()})(...${JSON.stringify(options.args)})`, page);
  });
  app.tabRows[0].url = 'https://www.google.com/search?q=China';
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(injections, ['MAIN', 'ISOLATED']);
  assert.equal(clicks, 1);
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 1);
  now += 5 * 60 * 1000;
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 2);
  // A changed exit bypasses the cooldown; a normal footer must not react to the search query.
  await app.send({ action: 'setManualLocation', latitude: 37.33, longitude: -121.89 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 3);
  now += 5 * 60 * 1000;
  for (const footer of ['95110, San Jose, CA - From your device', 'Chinatown', '']) {
    text = footer;
    await app.refresh();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(clicks, 3);
  for (const [footer, button] of [['中国', '更新位置'], ['中國', '更新位置'], ['CHINA', 'Update location']]) {
    text = footer; label = button;
    await app.refresh();
    await new Promise(resolve => setImmediate(resolve));
    now += 5 * 60 * 1000;
  }
  assert.equal(clicks, 6);
  hasFooter = false;
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  hasFooter = true; hasButton = false;
  await app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 6);
  assert.equal(app.notifications.length, 0);
  hasButton = true;
  for (const url of ['https://www.google.com/maps', 'https://www.google.com.evil.test/search', 'https://example.com/search']) {
    app.tabRows[0].url = url;
    await app.refresh();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(clicks, 6);
});

test('install and startup schedule a five-minute refresh and alarm fetches a new exit', async () => {
  const app = setup(async () => response(good));
  app.installed();
  await new Promise(resolve => setImmediate(resolve));
  app.startup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.alarms.length, 2);
  assert.equal(app.alarms.every(alarm => alarm.periodInMinutes === 5), true);
  const requests = app.requests.length;
  app.alarm('updateGeoAlarm');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests.length, requests + 1);
});

test('popup displays stored and action errors inline and allows acknowledgement without a dialog', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, textContent: '', hidden: false, addEventListener(type, handler) { this[type] = handler; } });
    return elements.get(id);
  };
  const store = { lastFailure: { id: 'failure-1', time: 'now', message: 'IP request timed out' } };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    chrome: {
      storage: { local: { async get() { return structuredClone(store); } }, onChanged: { addListener() {} } },
      tabs: { async query() { return []; } },
      runtime: { async sendMessage(request) {
        if (request.action === 'dismissFailure' && request.id === store.lastFailure.id) {
          delete store.lastFailure;
          return { ok: true };
        }
        throw new Error('Extension connection failed');
      } }
    }
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/popup.js`, 'utf8'), context);
  await vm.runInContext('displayLocation()', context);
  assert.match(element('status').textContent, /IP request timed out/);
  assert.equal(element('dismiss-failure').hidden, false);
  element('dismiss-failure').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('status').textContent, '');
  assert.equal(element('dismiss-failure').hidden, true);
  await vm.runInContext('performAction({ action: "manualUpdate" })', context);
  assert.match(element('status').textContent, /Extension connection failed/);
});
