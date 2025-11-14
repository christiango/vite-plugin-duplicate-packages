// @ts-check

/**
 * @typedef {import('node:child_process').ExecSyncOptions} ExecSyncOptions
 */

function untrackedFilesExist() {
  const execSync = require('child_process').execSync;

  const untrackedFiles = execSync('git ls-files -z --others --exclude-standard').toString('utf8').split('\0');

  let hasUntrackedFiles = false;

  untrackedFiles.forEach((file) => {
    if (file) {
      console.warn('warning: Untracked file found: ' + file);
      hasUntrackedFiles = true;
    }
  });

  return hasUntrackedFiles;
}

function clean(forceClean, scrub) {
  const execSync = require('child_process').execSync;

  // We want to remove all files except node_modules, so we need to exclude
  // those directories. We can't git clean with -X while excluding directories, and -x will
  // remove untracked files, possibly causing loss of work. As a result, let's check and make sure
  // there are no untracked files before we use -x, failing out with an error if there are any.
  const hasUntrackedFiles = untrackedFilesExist();

  if (hasUntrackedFiles && !forceClean) {
    console.error('\nERROR: Untracked files found.');
    console.error('To fix this issue, please stash, stage or remove untracked files before rerunning the command.');
    console.error('Errors encountered running ' + __filename + ', exiting with status = 1');
    process.exit(1);
  }

  try {
    /** @type {ExecSyncOptions} */ const execSyncOptions = {
      // Pipe stderr so we can parse it when errors occur.
      stdio: [0, 1, 'pipe'],
      env: { ...process.env, npm_config_yes: 'true' },
    };

    if (scrub) {
      execSync('git clean -fdx', execSyncOptions);
    } else {
      console.log('cleaning output (git clean)');
      execSync('git clean -fdx -e "/node_modules" -e "*/*/node_modules"', execSyncOptions);
    }
  } catch (e) {
    const errorOutput = e.stderr && e.stderr.toString();

    console.error(errorOutput);

    if (errorOutput.indexOf('EBUSY') > -1 || errorOutput.indexOf('Permission denied') > -1) {
      console.error('Clean failed due to permission denial.');
      console.error(
        'Please make sure you have no open files, directories or command prompts in gitignored areas attempting to be cleaned.'
      );
    } else if (errorOutput.indexOf('Filename too long') > -1) {
      console.error('Clean failed due to long filenames.');
      console.error(
        'Please ensure you are using git v2.32.0 or later to resolve an issue with git traversing ignored directories.\n'
      );
    } else {
      console.error('Unknown error occurred.');
    }
    console.error('\nErrors encountered running ' + __filename + ', exiting with status = 1');
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const forceClean = args.includes('--force');
const scrub = args.includes('--scrub');

clean(forceClean, scrub);
