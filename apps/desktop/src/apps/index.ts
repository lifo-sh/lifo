import type { AppRegistry } from '../core/AppRegistry';
import { finderDefinition } from './finder/FinderApp';
import { terminalDefinition } from './terminal/TerminalApp';
import { textEditDefinition } from './textedit/TextEditApp';
import { browserDefinition } from './browser/BrowserApp';
import { activityDefinition } from './activity/ActivityApp';
import { settingsDefinition } from './settings/SettingsApp';
import { aboutDefinition } from './about/AboutApp';

export const ALL_APPS = [finderDefinition, terminalDefinition, browserDefinition, textEditDefinition, activityDefinition, settingsDefinition, aboutDefinition];

/** Dock order. */
export const PINNED = ['finder', 'terminal', 'browser', 'textedit', 'activity', 'settings'];

export function registerBuiltinApps(registry: AppRegistry): void {
  for (const app of ALL_APPS) registry.register(app);
}
