import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { findGalleryImages, imageNameHint, safeImageFile } = await import('./files.ts');
const { config } = await import('../config.ts');

test('imageNameHint: meaningful prompt words, kebab-cased, stopwords and filler stripped', () => {
  assert.equal(imageNameHint('A sweeping medieval battlefield at dusk with a dragon'), 'sweeping-medieval-battlefield');
  assert.equal(imageNameHint('Ultra high quality, highly detailed pine forest at sunrise'), 'pine-forest-sunrise');
  assert.equal(imageNameHint('a single glowing green ember on a black background'), 'glowing-green-ember');
  assert.equal(imageNameHint('!!! ??? .. a of the'), 'image', 'garbage falls back to a safe default');
  // Whatever the hint, the resulting filename must pass the wire guard.
  assert.equal(safeImageFile(`${imageNameHint('shéér wéird ünicode prompt')}.png`).endsWith('.png'), true);
});

test('findGalleryImages: newest-first when unqueried, token-ranked when queried, empty on no match', () => {
  mkdirSync(config.home.images, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  writeFileSync(join(config.home.images, 'green-ember.png'), 'x');
  utimesSync(join(config.home.images, 'green-ember.png'), old, old);
  writeFileSync(join(config.home.images, 'dragon-battle.png'), 'x');

  assert.deepEqual(findGalleryImages(null, 2), ['dragon-battle.png', 'green-ember.png']);
  assert.deepEqual(findGalleryImages('the ember one'), ['green-ember.png']);
  assert.deepEqual(findGalleryImages('dragon'), ['dragon-battle.png']);
  assert.deepEqual(findGalleryImages('unicorn'), []);
});
