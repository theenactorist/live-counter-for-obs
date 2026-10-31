// T4: static checks on the Windows installer files. Runs on every machine, so
// the PowerShell 5.1 traps are caught before a push (the fixture tests that run
// the scripts need Windows: windows-install.test.ts).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly, lintPowerShell, missingRequirements } from './ps-lint.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = (rel: string) => path.join(root, rel);

const SCRIPTS = [
  { rel: 'installer/windows/install.ps1', downloads: true },
  { rel: 'installer/windows/uninstall.ps1', downloads: false },
];
const BATS = [
  { rel: 'installer/windows/Install Live Counter.bat', script: 'install.ps1' },
  { rel: 'installer/windows/Uninstall Live Counter.bat', script: 'uninstall.ps1' },
];

describe('Windows installer scripts: PowerShell 5.1 traps', () => {
  for (const { rel, downloads } of SCRIPTS) {
    it(`${rel} uses nothing newer than PowerShell 5.1 and none of the known traps`, () => {
      const problems = lintPowerShell(readFileSync(file(rel), 'utf8'));
      expect(problems.map((p) => `line ${p.line}: ${p.rule}: ${p.text}`)).toEqual([]);
    });

    it(`${rel} has strict mode, stop on errors and one script block`, () => {
      expect(missingRequirements(readFileSync(file(rel), 'utf8'), { downloads })).toEqual([]);
    });

    it(`${rel} has no BOM`, () => {
      const bytes = readFileSync(file(rel));
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    });
  }

  for (const { rel, script } of BATS) {
    it(`${rel} is plain ASCII with CRLF line ends and no BOM, runs ${script}, then pauses`, () => {
      const text = readFileSync(file(rel), 'latin1');
      expect(text.charCodeAt(0)).not.toBe(0xef);
      expect([...text].every((ch) => ch.charCodeAt(0) < 0x7f)).toBe(true);
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      const lines = text.split('\r\n');
      expect(lines).toContain(`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\\windows\\${script}"`);
      expect(lines.filter((l) => l !== '').at(-1)).toBe('pause');
    });
  }

  it('.gitattributes keeps .bat files CRLF', () => {
    expect(readFileSync(file('.gitattributes'), 'utf8')).toMatch(/^\*\.bat text eol=crlf$/m);
  });
});

describe('the PowerShell 5.1 trap check itself', () => {
  const flags = (src: string) => lintPowerShell(src).map((p) => p.rule.split(' (')[0]);

  it('flags each banned form', () => {
    expect(flags('$a = $b ?? 1')).toContain('the ?? operator');
    expect(flags('$a = $b ? 1 : 2')).toContain('the ternary operator');
    expect(flags('$o.a?.b')).toContain('the ?. operator');
    expect(flags('git pull && npm ci')).toContain('&& or || between commands');
    expect(flags('$h = $t | ConvertFrom-Json -AsHashtable')).toContain('-AsHashtable');
    expect(flags('$t = ConvertTo-Json -InputObject $o')).toContain('ConvertTo-Json without -Depth');
    expect(flags('$t = $o | ConvertTo-Json -Depth 100')).toContain('ConvertTo-Json fed by a pipeline');
    expect(flags('    exit 1')).toContain('exit');
    expect(flags('if ($x) { exit }')).toContain('exit');
    expect(flags('$t | Out-File x.txt')).toContain('Out-File');
    expect(flags('Set-Content -Path x -Value 1')).toContain('Set-Content or Add-Content');
    expect(flags('"a" > x.txt')).toContain('a > or >> redirection');
    expect(flags('[IO.File]::WriteAllText($p, $t)')).toContain('WriteAllText or WriteAllLines without an explicit encoding');
    expect(flags('Invoke-WebRequest -Uri $u -OutFile $f')).toContain('Invoke-WebRequest without -UseBasicParsing');
    expect(flags('Stop-Process -Name obs64')).toContain('Stop-Process');
    expect(flags("Say 'Tools → Scripts'")[0]).toMatch(/^a character outside plain ASCII/);
  });

  it('ignores the same words in comments and strings, and the forms that are fine', () => {
    const ok = [
      "# exit, ?? and Out-File in a comment",
      '<# exit 1 #>',
      "Say 'Please quit OBS, then press Enter. Done? Yes : no'",
      'Say "It will not exit && never Out-File"',
      '$t = ConvertTo-Json -InputObject $o -Depth 100 -Compress',
      '[IO.File]::WriteAllText($path, $text, $encoding)',
      'Invoke-WebRequest -Uri $u -OutFile $f -UseBasicParsing',
      'if ($a -gt 1 -and $b -ge 2) { $null = 1 }',
      '$null = New-Item -ItemType Directory -Path $p 2>$null',
      '$LcExitCode = 0',
      'function Get-ExitMessage { return 1 }',
    ].join('\n');
    expect(lintPowerShell(ok)).toEqual([]);
  });

  it('blanks string text but keeps the code around it', () => {
    expect(codeOnly("Say 'a ?? b' # exit")).toBe("Say '      '       ");
  });
});
