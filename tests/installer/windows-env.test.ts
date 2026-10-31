// T4: the Windows installer tests are only worth something if they run on
// Windows PowerShell 5.1 (what the church PC has), not PowerShell 7, and if the
// fake obs64.exe really carries the version install.ps1 reads. Windows only.
import { describe, expect, it, vi } from 'vitest';
import { fakeObsExe, powershell } from './windows-fixtures.js';

vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(process.platform !== 'win32')('Windows test machine', () => {
  it('runs the scripts with Windows PowerShell 5.1', () => {
    const out = powershell('$PSVersionTable.PSVersion.ToString() + " " + $PSVersionTable.PSEdition').trim();
    expect(out).toMatch(/^5\.1\.\d+\.\d+ Desktop$/);
  });

  it('builds a fake obs64.exe whose file version reads back', () => {
    const exe = fakeObsExe('30.2.3');
    const out = powershell(
      `$v = (Get-Item -LiteralPath '${exe}').VersionInfo; '{0}.{1}.{2}' -f $v.FileMajorPart, $v.FileMinorPart, $v.FileBuildPart`,
    ).trim();
    expect(out).toBe('30.2.3');
  });
});
