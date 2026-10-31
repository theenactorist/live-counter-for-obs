// T4: a small static check for the Windows installer scripts, so the traps
// that only Windows PowerShell 5.1 would show are caught on any machine
// (docs/installer-spike.md, "Windows notes", and the T4 brief). It strips
// comments and string text first, so copy such as "Please quit OBS?" or a
// comment that names a banned form does not count.

/** Code with comments removed and the inside of every string blanked (quotes kept). */
export function codeOnly(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    // Block comment <# ... #>
    if (c === '<' && next === '#') {
      const end = source.indexOf('#>', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    // Line comment
    if (c === '#') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    // Here-strings @' ... '@ and @" ... "@ (the closing mark starts a line)
    if (c === '@' && (next === "'" || next === '"') && /^[ \t]*\r?\n/.test(source.slice(i + 2, i + 4))) {
      const close = new RegExp(`\\n${next}@`, 'g');
      close.lastIndex = i + 2;
      const m = close.exec(source);
      const stop = m ? m.index + 3 : n;
      out += '@' + next + source.slice(i + 2, stop - 2).replace(/[^\n]/g, ' ') + next + '@';
      i = stop;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "'" && source[j + 1] === "'") j += 2;
        else if (source[j] === "'") break;
        else j++;
      }
      out += "'" + source.slice(i + 1, j).replace(/[^\n]/g, ' ') + "'";
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '`') j += 2;
        else if (source[j] === '"' && source[j + 1] === '"') j += 2;
        else if (source[j] === '"') break;
        else j++;
      }
      out += '"' + source.slice(i + 1, j).replace(/[^\n]/g, ' ') + '"';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface Rule {
  name: string;
  test: (code: string, line: string) => boolean;
}

// Each rule looks at one line of code (comments and string text blanked).
const RULES: Rule[] = [
  { name: 'exit (closes the window under irm | iex; return from the main function instead)', test: (_, l) => /(^|[^\w$-])exit\b/i.test(l) },
  { name: 'the ?? operator (PowerShell 7)', test: (_, l) => /\?\?/.test(l) },
  { name: 'the ?. operator (PowerShell 7)', test: (_, l) => /\?\./.test(l) },
  { name: 'the ternary operator (PowerShell 7)', test: (_, l) => /\s\?\s[^:]*\s:\s/.test(l) },
  { name: '&& or || between commands (PowerShell 7)', test: (_, l) => /&&|\|\|/.test(l) },
  { name: '-AsHashtable (PowerShell 6)', test: (_, l) => /-AsHashtable\b/i.test(l) },
  { name: 'ConvertTo-Json without -Depth (5.1 flattens below depth 2)', test: (_, l) => /ConvertTo-Json\b/i.test(l) && !/-Depth\s+100\b/i.test(l) },
  { name: 'ConvertTo-Json fed by a pipeline (unrolls one-item arrays; use -InputObject)', test: (_, l) => /\|\s*ConvertTo-Json\b/i.test(l) },
  { name: 'ConvertFrom-Json -Depth (PowerShell 6)', test: (_, l) => /ConvertFrom-Json\b[^|;]*-Depth\b/i.test(l) },
  { name: 'Out-File (UTF-16 in 5.1)', test: (_, l) => /\bOut-File\b/i.test(l) },
  { name: 'Set-Content or Add-Content (ANSI in 5.1)', test: (_, l) => /\b(Set|Add)-Content\b/i.test(l) },
  { name: 'a > or >> redirection (UTF-16 in 5.1)', test: (_, l) => /(^|[^-\w])\d?>>?(?!\s*\$null)/.test(l.replace(/-(gt|ge|lt|le)\b/gi, '')) },
  { name: 'WriteAllText or WriteAllLines without an explicit encoding', test: (_, l) => /\]::WriteAll(Text|Lines)\(/i.test(l) && !/\$encoding\b/.test(l) },
  { name: 'Invoke-WebRequest without -UseBasicParsing', test: (_, l) => /\bInvoke-WebRequest\b/i.test(l) && !/-UseBasicParsing\b/i.test(l) },
  { name: 'Invoke-RestMethod (use Invoke-WebRequest -UseBasicParsing -OutFile)', test: (_, l) => /\b(Invoke-RestMethod|irm)\b/i.test(l) },
  { name: 'Stop-Process (never force OBS closed)', test: (_, l) => /\bStop-Process\b|\.Kill\(/i.test(l) },
  { name: 'ForEach-Object -Parallel (PowerShell 7)', test: (_, l) => /-Parallel\b/i.test(l) },
  { name: '-SkipCertificateCheck or -AsByteStream (PowerShell 6)', test: (_, l) => /-(SkipCertificateCheck|AsByteStream)\b/i.test(l) },
  { name: '$IsWindows, $IsMacOS or $IsLinux (PowerShell 6)', test: (_, l) => /\$Is(Windows|MacOS|Linux)\b/i.test(l) },
  { name: 'utf8NoBOM encoding name (PowerShell 6)', test: (_, l) => /utf8NoBOM/i.test(l) },
  { name: 'Test-Json (PowerShell 6)', test: (_, l) => /\bTest-Json\b/i.test(l) },
];

export interface Problem {
  line: number;
  rule: string;
  text: string;
}

/** Every banned form in a .ps1 source, with 1-based line numbers. */
export function lintPowerShell(source: string): Problem[] {
  const problems: Problem[] = [];
  const code = codeOnly(source).split('\n');
  const raw = source.split('\n');
  code.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.test(code.join('\n'), line)) problems.push({ line: i + 1, rule: rule.name, text: raw[i]!.trim() });
    }
  });
  for (let i = 0; i < raw.length; i++) {
    const bad = [...raw[i]!].find((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && ch !== '\t' && ch !== '\r'));
    if (bad !== undefined) {
      problems.push({
        line: i + 1,
        rule: `a character outside plain ASCII (U+${bad.charCodeAt(0).toString(16).padStart(4, '0')}): 5.1 reads a .ps1 without a BOM in the ANSI code page`,
        text: raw[i]!.trim(),
      });
    }
  }
  return problems;
}

/** Statements every installer script must have. */
export function missingRequirements(source: string, opts: { downloads: boolean }): string[] {
  const code = codeOnly(source);
  const missing: string[] = [];
  if (!/Set-StrictMode\s+-Version\s+2\b/i.test(code)) missing.push('Set-StrictMode -Version 2');
  // String text is blanked in `code`, so this one reads the source, anchored to a line start.
  if (!/^\s*\$ErrorActionPreference\s*=\s*'Stop'\s*$/im.test(source)) missing.push("$ErrorActionPreference = 'Stop'");
  if (!/^\s*&\s*\{/m.test(code)) missing.push('the whole script inside & { ... } (so irm | iex leaves nothing behind)');
  if (opts.downloads) {
    if (!/SecurityProtocolType\]::Tls12/.test(code)) missing.push('TLS 1.2 turned on before downloading');
    if (!/\bExpand-Archive\b/i.test(code)) missing.push('Expand-Archive to unpack');
  }
  return missing;
}
