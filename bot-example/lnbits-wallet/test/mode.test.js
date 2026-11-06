// "npm run test:db" must really run against the registry, not fall back to wallets.js.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../registry.js';
import { Wallets } from '../wallets.js';

test(
  'the suite runs against the storage it says it does',
  { skip: process.env.npm_lifecycle_event === undefined },
  () => {
    const database = process.env.npm_lifecycle_event === 'test:db';
    assert.equal(new Wallets([]) instanceof Registry, database);
  },
);
