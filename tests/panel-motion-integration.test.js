import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { PAGE_LAYOUT_ATTRIBUTE, PAGE_PANEL_WIDTH_PROPERTY } from '../src/core/panel-layout.js';

const source = buildSync({ entryPoints: ['src/content/index.js'], bundle: true, write: false, format: 'iife' }).outputFiles[0].text;

test('extension-owned layout stylesheet updates do not invalidate page context', async t => {
  const dom = new JSDOM('<!doctype html><body><main>Public fixture</main></body>', {
    url: 'https://example.com/article', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  let shadow;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(options) { shadow = attach.call(this, options); return shadow; };
  const messages = [];
  window.MessageChannel = class {
    constructor() {
      this.port1 = { start() {}, close() {}, postMessage(message) { messages.push(message); } };
      this.port2 = {};
    }
  };
  window.browser = { runtime: { getURL: path => `https://extension.example/${path}` } };
  window.eval(source);
  window.__safaiTogglePanel();
  shadow.querySelector('iframe').dispatchEvent(new window.Event('load'));
  const style = window.document.getElementById('safai-extension-page-layout-style-site');
  style.textContent = 'html[data-safai-extension-panel-open] main { min-width: 0; }';
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(messages.filter(message => message.type === 'PAGE_CONTEXT_INVALIDATED').length, 0);
  window.document.querySelector('main').textContent = 'Actual article update';
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(messages.filter(message => message.type === 'PAGE_CONTEXT_INVALIDATED').length, 1);
});

test('animated content bridge settles before capture and cannot paint the panel back into a stalled capture', async t => {
  const dom = new JSDOM('<!doctype html><body><main>Public fixture</main></body>', {
    url: 'https://example.com/article', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.Element.prototype.animate = () => ({ cancel() {} });
  let shadow;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(options) { shadow = attach.call(this, options); return shadow; };
  let port;
  let reply;
  window.MessageChannel = class {
    constructor() {
      this.port1 = port = { start() {}, close() {}, postMessage(message) { reply?.(message); } };
      this.port2 = {};
    }
  };
  window.browser = { runtime: {
    getURL: path => `https://extension.example/${path}`,
    sendMessage: () => { throw new Error('capture must not start without a paint'); },
  } };
  window.eval(source);
  window.__safaiTogglePanel();
  const root = window.document.documentElement;
  const host = window.document.getElementById('safai-extension-panel-host');
  assert.equal(root.style.getPropertyValue(PAGE_PANEL_WIDTH_PROPERTY), '342px');
  assert.match(shadow.querySelector('.panel-surface').style.transform, /342px/);
  // A reversal before the first frame must not leave a hidden reservation.
  window.__safaiTogglePanel();
  assert.equal(root.hasAttribute(PAGE_LAYOUT_ATTRIBUTE), false);
  window.__safaiTogglePanel();
  shadow.querySelector('iframe').dispatchEvent(new window.Event('load'));
  const originalTimer = window.setTimeout.bind(window);
  window.setTimeout = (fn, delay) => originalTimer(fn, delay >= 2000 ? 30 : delay);
  window.requestAnimationFrame = () => 777;
  const result = new Promise(resolve => { reply = resolve; });
  port.onmessage({ data: { type: 'CAPTURE_VIEWPORT', requestId: 1 } });
  assert.equal(host.style.display, 'none');
  assert.equal(root.hasAttribute(PAGE_LAYOUT_ATTRIBUTE), false);
  const response = await result;
  assert.equal(response.ok, false);
  assert.match(response.error, /has not updated/);
  assert.equal(host.style.display, 'block');
  assert.equal(host.style.transform, 'none');
  assert.equal(shadow.querySelector('.panel-surface').style.transform, 'translateX(0px)');
  assert.equal(root.style.getPropertyValue(PAGE_PANEL_WIDTH_PROPERTY), '342px');
});
