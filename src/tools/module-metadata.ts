import { driveTools } from './drive/index.js';
import { spreadsheetTools } from './spreadsheet/index.js';
import { mailplusTools } from './mailplus/index.js';
import { calendarTools } from './calendar/index.js';
import { downloadStationTools } from './download-station/index.js';
import type { FeatureFlags } from '../types/index.js';

export type FeatureModule = keyof FeatureFlags;

export interface ModuleMetadata {
  key: FeatureModule;
  displayName: string;
  toolPrefix: string;
  toolCount: number;
}

export const MODULE_METADATA: ModuleMetadata[] = [
  {
    key: 'drive',
    displayName: 'Synology Drive',
    toolPrefix: 'drive_',
    toolCount: driveTools.length,
  },
  {
    key: 'spreadsheet',
    displayName: 'Synology Spreadsheet',
    toolPrefix: 'spreadsheet_',
    toolCount: spreadsheetTools.length,
  },
  {
    key: 'mailplus',
    displayName: 'MailPlus Server',
    toolPrefix: 'mailplus_',
    toolCount: mailplusTools.length,
  },
  {
    key: 'calendar',
    displayName: 'Synology Calendar',
    toolPrefix: 'calendar_',
    toolCount: calendarTools.length,
  },
  {
    key: 'downloadStation',
    displayName: 'Download Station',
    toolPrefix: 'download_',
    toolCount: downloadStationTools.length,
  },
];
