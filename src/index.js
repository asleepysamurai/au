/**
 * AutoUpdater Entry Point
 */

const path = require('path');
const fork = require('child_process').fork;
const superagent = require('superagent');
const { promisify } = require('util');
const untar = promisify(require('targz').decompress);
const rimraf = promisify(require('rimraf'));
const fs = require('fs');
const compareVersions = require('compare-versions');
const isSemver = require('is-semver');
const mkdirp = require('make-dir');

const debug = require('./debug')('au:index');

const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

const defaultUpdateCheckInterval = (1000 * 60 * 60 * 24) * 1; //Check every 1 days

let isUpdating = false;

function downloadUpdateFile(url, dir, checksum) {
    return new Promise((resolve, reject) => {
        try {
            const cp = fork(path.join(__dirname, './downloader'), [
                `--url=${url}`,
                `--dir=${dir}`,
                `--checksum=${checksum}`
            ], process.env.NODE_ENV == 'development' ? { execArgv: [`--inspect=${9230}`] } : null);

            if (cp.stdout)
                cp.stdout.pipe(process.stdout);
            if (cp.stderr)
                cp.stderr.pipe(process.stderr);

            cp.on('message', message => {
                if (message.success && message.code == 'DOWNLOADENDED')
                    return resolve(message.updateFilePath);

                if (!message.success)
                    return reject(message);
            });
        } catch (err) {
            debug('Failed to setup file downloader', err);
            reject(err);
        }
    });
};

async function ensureDirExists(dirPath) {
    if (dirPath) {
        return await mkdirp(dirPath);
    }
};

function setupUpdateChecker(opts, currentSemver) {
    const updateCheckInterval = opts.updateCheckInterval || defaultUpdateCheckInterval;
    setInterval(updateIfAvailable.bind(null, opts, currentSemver), updateCheckInterval); //Setup every x ms check
    setImmediate(updateIfAvailable.bind(null, opts, currentSemver)); //Setup immediate check
};

async function getAvailableSemvers(opts) {
    try {
        const itemsInDir = await readdir(opts.dirPath);
        const areItemsDirs = itemsInDir.map(item => stat(path.join(opts.dirPath, `./${item}`)));

        const stats = await Promise.all(areItemsDirs);
        let dirs = [];
        let files = [];

        itemsInDir.forEach((item, i) => {
            if (stats[i].isDirectory() && isSemver(item))
                dirs.push(item);
            else if (stats[i].isFile())
                files.push(item);
        });

        const availableSemvers = dirs.filter(dirName => files.indexOf(`${dirName}.tar.gz`) == -1);
        return availableSemvers.sort(compareVersions);
    } catch (err) {
        if (err && err.code == 'ENOENT') {
            debug(`Provided dirPath: ${opts.dirPath} not present. Ignoring.`);
            return [];
        }

        throw err;
    }
};

async function getLatestAvailableSemver(opts) {
    const availableSemvers = await getAvailableSemvers(opts);
    return availableSemvers[availableSemvers.length - 1];
};

async function updateIfAvailable(opts, currentSemver) {
    if (isUpdating) {
        const error = new Error('Update already in process. Quitting this interval.');
        return debug(error);
    }

    if (!(opts && opts.url && opts.shouldDownload && opts.getDownloadURL)) {
        const error = new Error('Invalid update check url');
        return debug(error);
    }

    isUpdating = true;

    await ensureDirExists(opts.dirPath);

    let updateJSON;
    try {
        updateJSON = (await superagent
                .get(opts.url)
                .set('User-Agent', opts.userAgent || 'node-au')
                .accept('json') || {})
            .body;
    } catch (err) {
        isUpdating = false;

        if (err instanceof SyntaxError) {
            const error = new Error('Invalid update manifest');
            return debug(error);
        } else {
            const error = new Error('Update check failed');
            return debug(error);
        }
    }

    const semver = opts.getSemver(updateJSON);
    const availableSemvers = await getAvailableSemvers(opts);
    const isVersionAlreadyDownloaded = availableSemvers.indexOf(semver) > -1;
    const isUpdateVersionNewerThanCurrent = compareVersions(semver, currentSemver) == 1;

    debug(JSON.stringify({ isVersionAlreadyDownloaded, isUpdateVersionNewerThanCurrent, currentSemver, semver, opts }));

    if (isVersionAlreadyDownloaded || !isUpdateVersionNewerThanCurrent) {
        isUpdating = false;
        return debug(`No updates available. Quitting update check.`);
    }

    const shouldDownload = opts.shouldDownload(updateJSON);

    if (shouldDownload instanceof Promise ? await shouldDownload : shouldDownload) {
        let updateFilePath;
        let extractDir;
        const downloadURL = opts.getDownloadURL(updateJSON);

        try {
            updateFilePath = await downloadUpdateFile(downloadURL, opts.dirPath, opts.getChecksum(updateJSON));

            extractDir = path.join(opts.dirPath, `./${semver}`);
            debug(`Extracting update targz to ${extractDir}`);

            await rimraf(extractDir);
            process.noAsar = true;
            await untar({
                src: updateFilePath,
                dest: extractDir,
                tar: {
                    dereference: true
                }
            });
            process.noAsar = false;
            await unlink(updateFilePath);

            isUpdating = false;

            if (opts.onUpdateReady)
                return opts.onUpdateReady(semver, updateJSON);
        } catch (err) {
            if (updateFilePath) {
                await unlink(updateFilePath);
            }

            if (extractDir) {
                await rimraf(extractDir);
            }

            isUpdating = false;

            debug(`Failed to download and extract ${downloadURL}. Deleting downloaded file.`, err);
            return //throw err;
        }
    }
};

async function getExecutable(opts) {
    const dirPaths = Array.isArray(opts.dirPath) ? opts.dirPath : [opts.dirPath];

    const getExecutables = dirPaths.map(async (dirPath) => {
        const semver = opts.version || await getLatestAvailableSemver(Object.assign({}, opts, { dirPath }));
        if (!semver) {
            return;
        }

        const requirePath = path.join(dirPath, `./${semver}`);
        return {
            requirePath,
            semver
        };
    });

    const executablesByDir = (await Promise.all(getExecutables)).filter(e => !!e);
    const executablesSortedBySemver = executablesByDir.sort((a, b) => compareVersions(a.semver, b.semver));

    const executable = executablesSortedBySemver.pop();
    debug(`Requiring version ${executable.semver} from ${executable.requirePath}`);
    return executable;
};

async function test() {
    const { requirePath, semver } = await init({
        shouldDownload: () => true,
        dirPath: path.join(__dirname, './tmp'),
        url: 'http://localhost:3002/update.json',
        getDownloadURL: manifest => manifest.url,
        getChecksum: manifest => manifest.checksum,
        getSemver: manifest => manifest.semver,
        onUpdateReady: semver => {
            debug(`Update version ${semver} Extracted and Ready to go.
Manifest: ${JSON.stringify(updateJSON)}`);
        }
    });

    debug(`requirePath: ${requirePath}`);
    debug(`semver: ${semver}`);
};

if (require.main === module)
    test();

async function init(opts) {
    const executable = await getExecutable(opts);
    setupUpdateChecker(opts, executable.semver);

    return executable;
};

module.exports = {
    getExecutable,
    setupUpdateChecker
};
