import { duplicatePackagesPlugin } from './DuplicatePackagesPlugin.js';
export {
  duplicatePackagesPlugin,
  DuplicatePackagesConfig,
  DuplicateAnalysisResult,
  DuplicatePackageError,
  analyzeModuleGraph,
  analyzeForDuplicates,
  formatDuplicateMessage,
} from './DuplicatePackagesPlugin.js';
export default duplicatePackagesPlugin;
