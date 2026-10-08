// Load every domain catalog once at application startup. Individual modules may
// also import their own catalog so isolated fixtures keep translated copy.
import { zhCN } from '../messages';
import { adaptersZhCN } from './adapters';
import './app';
import { componentsZhCN } from './components';
import managementZhCN from './management';
import './real-core';
import './runs';
import { workspaceZhCN } from './workspace';
import '../../home/catalog';

Object.assign(zhCN, adaptersZhCN, componentsZhCN, managementZhCN, workspaceZhCN);
