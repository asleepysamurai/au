/**
 * AutoUpdater Entry Point
 */

const path = require('path');
const debug = require('debug')('au:index');
const fork = require('child_process').fork;
const superagent = require('superagent');
const { promisify } = require('util');
const untar = promisify(require('targz').decompress);
const rimraf = promisify(require('rimraf'));
const fs = require('fs');
const compareVersions = require('compare-versions');
const isSemver = require('is-semver');
const mkdirp = require('make-dir');

const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

const defaultUpdateCheckInterval = (1000 * 60 * 60 * 24) * 1; //Check every 1 days

let isUpdating = false;

function downloadUpdateFile(url, dir, checksum) {
    return new Promise((resolve, reject) => {
        const cp = fork(path.join(__dirname, './downloader'), [
            `--url=${url}`,
            `--dir=${dir}`,
            `--checksum=${checksum}`
        ], process.env.NODE_ENV == 'development' ? { execArgv: [`--inspect=${9230}`] } : null);

        cp.on('message', message => {
            if (message.success && message.code == 'DOWNLOADENDED')
                return resolve(message.updateFilePath);

            if (!message.success)
                return reject(message);
        });
    });
};

async function ensureDirExists(dirPath) {
    if (dirPath)
        return await mkdirp(dirPath);
};

function setupUpdateChecker(opts) {
    const updateCheckInterval = opts.updateCheckInterval || defaultUpdateCheckInterval;
    setInterval(updateIfAvailable.bind(null, opts), updateCheckInterval); //Setup every x ms check
    setImmediate(updateIfAvailable.bind(null, opts)); //Setup immediate check
};

async function getAvailableSemvers(opts) {
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
};

async function getLatestAvailableSemver(opts) {
    const availableSemvers = await getAvailableSemvers(opts);
    return availableSemvers[availableSemvers.length - 1];
};

async function updateIfAvailable(opts) {
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

    const shouldDownload = opts.shouldDownload(updateJSON);

    if (isVersionAlreadyDownloaded) {
        isUpdating = false;
        return debug(`No updates available. Quitting update check.`);
    }

    if (shouldDownload instanceof Promise ? await shouldDownload : shouldDownload) {
        let updateFilePath;
        const downloadURL = opts.getDownloadURL(updateJSON);

        try {
            updateFilePath = await downloadUpdateFile(downloadURL, opts.dirPath, opts.getChecksum(updateJSON));

            const extractDir = path.join(opts.dirPath, `./${semver}`);
            debug(`Extracting update targz to ${extractDir}`);

            await rimraf(extractDir);
            await untar({
                src: updateFilePath,
                dest: extractDir
            });
            await unlink(updateFilePath);

            isUpdating = false;

            if (opts.onUpdateReady)
                return opts.onUpdateReady(semver);
        } catch (err) {
            if (updateFilePath)
                await unlink(updateFilePath);

            isUpdating = false;

            debug(`Failed to download and extract ${downloadURL}. Deleting downloaded file.`);
            return //throw err;
        }
    }
};

async function getExecutable(opts) {
    const dirPaths = Array.isArray(opts.dirPath) ? opts.dirPath : [opts.dirPath];

    const getExecutables = dirPaths.map(async(dirPath) => {
        await ensureDirExists(dirPath);

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
        onUpdateReady: semver => debug(`Update version ${semver} Extracted and Ready to go.`)
    });

    debug(`requirePath: ${requirePath}`);
    debug(`semver: ${semver}`);
};

if (require.main === module)
    test();

async function init(opts) {
    setupUpdateChecker(opts);
    return await getExecutable(opts);
};

module.exports = {
    getExecutable,
    setupUpdateChecker
};
