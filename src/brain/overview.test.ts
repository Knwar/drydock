import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { commandIn } from './routes-overview.js';

describe('project overview', () => {
  it('finds the command a blocker asks the user to run', () => {
    assert.equal(commandIn('Needs uv installed on the Mac (brew install uv). Only Kanwar can install software.'), 'brew install uv');
    assert.equal(commandIn('Needs ffmpeg 7.x installed on the Mac (brew install ffmpeg). Only Kanwar can.'), 'brew install ffmpeg');
    assert.equal(commandIn('Run `pnpm install` in the web folder first'), 'pnpm install');
    assert.equal(commandIn('Which database should we use: Postgres or SQLite?'), null);
    assert.equal(commandIn(null), null);
  });
});
