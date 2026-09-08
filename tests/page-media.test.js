import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPageMediaLayout, shiftedWidthQuery } from '../src/content/page-media.js';

test('width breakpoints use available page width without changing unrelated conditions', () => {
  assert.equal(shiftedWidthQuery('(min-width: 1000px) and (prefers-color-scheme: dark)', 342), '(min-width: 1342px) and (prefers-color-scheme: dark)');
  assert.equal(shiftedWidthQuery('(max-width: 60em)', 320), '(max-width: 80em)');
  assert.equal(shiftedWidthQuery('(min-height: 700px)', 342), '(min-height: 700px)');
});

test('stylesheet media conditions restore after resize and close', () => {
  const dom = new JSDOM('<style>@media (min-width: 1000px) { main { width: 900px } }</style><main></main>');
  const media = dom.window.document.styleSheets[0].cssRules[0].media;
  const controller = createPageMediaLayout(dom.window.document);
  controller.apply(342);
  assert.equal(media.mediaText, '(min-width: 1342px)');
  controller.apply(400);
  assert.equal(media.mediaText, '(min-width: 1400px)');
  controller.clear();
  assert.equal(media.mediaText, '(min-width: 1000px)');
  dom.window.close();
});

test('closing preserves a newer media condition authored by the page', () => {
  const dom = new JSDOM('<style>@media (min-width: 1000px) { main { width: 900px } }</style>');
  const media = dom.window.document.styleSheets[0].cssRules[0].media;
  const controller = createPageMediaLayout(dom.window.document);
  controller.apply(342);
  media.mediaText = '(min-width: 800px)';
  controller.clear();
  assert.equal(media.mediaText, '(min-width: 800px)');
  dom.window.close();
});
