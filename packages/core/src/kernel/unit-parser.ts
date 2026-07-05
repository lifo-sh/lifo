/**
 * INI-style unit file parser for systemd-like service definitions.
 */

export interface UnitFile {
  Unit: {
    Description?: string;
  };
  Service: {
    ExecStart?: string;
    ExecStop?: string;
    Type?: 'simple' | 'oneshot';
    Restart?: 'no' | 'always' | 'on-failure';
    RestartSec?: number;
    Environment?: Record<string, string>;
    WorkingDirectory?: string;
  };
  Install: {
    WantedBy?: string;
  };
}

export function parseUnitFile(content: string): UnitFile {
  const unit: UnitFile = {
    Unit: {},
    Service: {},
    Install: {},
  };

  let currentSection: keyof UnitFile | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1] as keyof UnitFile;
      if (name in unit) {
        currentSection = name;
      }
      continue;
    }

    if (!currentSection) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    switch (currentSection) {
      case 'Unit':
        if (key === 'Description') unit.Unit.Description = value;
        break;
      case 'Service':
        switch (key) {
          case 'ExecStart': unit.Service.ExecStart = value; break;
          case 'ExecStop': unit.Service.ExecStop = value; break;
          case 'Type':
            if (value === 'simple' || value === 'oneshot') unit.Service.Type = value;
            break;
          case 'Restart':
            if (value === 'no' || value === 'always' || value === 'on-failure') unit.Service.Restart = value;
            break;
          case 'RestartSec':
            unit.Service.RestartSec = parseInt(value, 10) || 0;
            break;
          case 'Environment': {
            if (!unit.Service.Environment) unit.Service.Environment = {};
            // Parse KEY=VALUE pairs (space-separated)
            for (const pair of value.split(/\s+/)) {
              const pairEq = pair.indexOf('=');
              if (pairEq !== -1) {
                const k = pair.slice(0, pairEq);
                const v = pair.slice(pairEq + 1).replace(/^"|"$/g, '');
                unit.Service.Environment[k] = v;
              }
            }
            break;
          }
          case 'WorkingDirectory':
            unit.Service.WorkingDirectory = value;
            break;
        }
        break;
      case 'Install':
        if (key === 'WantedBy') unit.Install.WantedBy = value;
        break;
    }
  }

  return unit;
}
