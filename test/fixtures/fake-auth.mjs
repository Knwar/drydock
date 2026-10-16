#!/usr/bin/env node
// Stand-in for brain-auth (Touch ID): confirms unless the file FAKE_VAULT.deny exists.
import { existsSync } from 'node:fs';
import { logArgv } from './fake-vault.mjs';
logArgv('auth');
process.exit(existsSync(process.env.FAKE_VAULT + '.deny') ? 1 : 0);
