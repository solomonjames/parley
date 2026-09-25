import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENTS } from '../src/setup.js';

describe('parley install/uninstall targets', () => {
  it('install then uninstall leaves existing config exactly as it was', () => {
    const home = mkdtempSync(join(tmpdir(), 'parley-home-'));
    const prev = process.env.HOME;

    process.env.HOME = home;

    try {
      mkdirSync(join(home, '.claude'));
      mkdirSync(join(home, '.codex'));

      const claudeJson = `${JSON.stringify(
        { numStartups: 3, mcpServers: { other: { command: 'x' } } },
        null,
        2,
      )}\n`;

      writeFileSync(join(home, '.claude.json'), claudeJson);
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# my notes\n');
      writeFileSync(
        join(home, '.codex', 'config.toml'),
        '[model]\nname = "x"\n',
      );

      const scope = { local: false, cwd: home };

      for (const t of ['claude-code', 'codex', 'cursor', 'gemini'])
        CLIENTS[t].install(scope);

      const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));

      expect(cfg.mcpServers.parley).toMatchObject({
        type: 'stdio',
        alwaysLoad: true,
        command: 'npx',
      });
      expect(cfg.mcpServers.other).toEqual({ command: 'x' });
      expect(
        readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'),
      ).toContain('Never split or restructure a purchase');
      expect(CLIENTS['claude-code'].installed(scope)).toBe(true);
      // idempotent
      CLIENTS['claude-code'].install(scope);
      expect(
        readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8').match(
          /PARLEY_START/g,
        ),
      ).toHaveLength(1);

      for (const t of ['claude-code', 'codex', 'cursor', 'gemini'])
        CLIENTS[t].uninstall(scope);

      expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(
        claudeJson.replace('"x"\n    }\n  }', '"x"\n    }\n  }'),
      );
      expect(
        JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')),
      ).toEqual(JSON.parse(claudeJson));
      expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(
        '# my notes\n',
      );
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
        '[model]\nname = "x"\n',
      );
      expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(true);
      expect(CLIENTS.cursor.installed(scope)).toBe(false);
    } finally {
      process.env.HOME = prev;
    }
  });
});
