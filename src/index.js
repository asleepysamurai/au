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

const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

const defaultUpdateCheckInterval = (1000 * 60 * 60 * 24) * 1; //Check every 1 days

function downloadUpdateFile(url, dir, checksum) {
    return new Promise((resolve, reject) => {
        const cp = fork(path.join(__dirname, './downloader'), [
            `--url=${url}`,
            `--dir=${dir}`,
            `--checksum=${checksum}`
        ], { execArgv: [`--inspect=${9230}`] });

        cp.on('message', message => {
            if (message.success && message.code == 'DOWNLOADENDED')
                return resolve(message.updateFilePath);

            if (!message.success)
                return reject(message);
        });
    });
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
    if (!(opts && opts.url && opts.shouldDownload && opts.getDownloadURL))
        throw new Error('Invalid update check url');

    let updateJSON;
    try {
        updateJSON = (await superagent
                .get(opts.url)
                .accept('json') || {})
            .body;
    } catch (err) {
        if (err instanceof SyntaxError) {
            const error = new Error('Invalid update manifest');
            error.code == 'EBADMANIFEST';
            throw error;
        } else {
            const error = new Error('Update check failed');
            error.code == 'ECHECKFAIL';
            throw error;
        }
    }

    const semver = opts.getSemver(updateJSON);
    const availableSemvers = await getAvailableSemvers(opts);
    const isVersionAlreadyDownloaded = availableSemvers.indexOf(semver) > -1;

    const shouldDownload = opts.shouldDownload(updateJSON);

    if (isVersionAlreadyDownloaded) {
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

            if (opts.onUpdateReady)
                return opts.onUpdateReady(semver);
        } catch (err) {
            if (updateFilePath)
                await unlink(updateFilePath);

            debug(`Failed to download and extract ${downloadURL}. Deleting downloaded file.`);
            throw err;
        }
    }
};

async function getExecutable(opts) {
    const semver = opts.version || await getLatestAvailableSemver(opts);
    const dirPath = path.join(opts.dirPath, `./${semver}`);

    debug(`Requiring version ${semver} from ${dirPath}`);
    return {
        requirePath: dirPath,
        semver: semver
    };
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

//test();

async function init(opts) {
    setupUpdateChecker(opts);
    return await getExecutable(opts);
};

module.exports = {
    init
};
