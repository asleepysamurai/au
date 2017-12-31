/**
 * Given a url and a directory, 
 * downloads the tar file at that url
 * Once downloaded untars the tar file
 * into specified directory.
 *
 * Can resume downloads.
 */

const argv = require('minimist')(process.argv.slice(2));
const debug = require('debug')('au');
const mkdirp = require('make-dir');
const path = require('path');
const FD = require('fast-download');
const fs = require('fs');
const { promisify } = require('util');

const access = promisify(fs.access);
const unlink = promisify(fs.unlink);

function messageAndExit(message, success = true) {
    message.success = success;

    if (process.send)
        process.send(message);
    else
        debug(message);
    process.exit(success ? 0 : 1);
};

function fileExists(filePath) {
    return access(filePath, fs.constants.F_OK);
};

function fileReadWritable(filePath) {
    return access(filePath, fs.constants.R_OK | fs.constants.W_OK);
};

function download(filePath, url, onStart = () => {}, onEnd = () => {}) {
    debug(`Downloading with url: ${url} and filePath: ${filePath}`);
    const downloader = new FD(url, {
        destFile: filePath,
        resumeFile: true
    });

    downloader.on('start', onStart);
    downloader.on('error', onEnd);
    downloader.on('end', onEnd);
};

async function startOrResumeDownload(url, dir, fileName) {
    const downloadFileName = fileName || path.basename(url);

    const downloadFilePath = path.resolve(dir, downloadFileName);
    const resumeFilePath = path.resolve(dir, `${downloadFileName}.mtd`);

    function onStart() {
        debug(`Starting download of ${url} to ${resumeFilePath}`);
    };

    async function onEnd(err) {
        if (err && err.message && err.message.indexOf('.mtd') > -1) {
            debug(`.mtd corrupt. delete and start again`);
            await unlink(resumeFilePath);
            return await startOrResumeDownload(url, dir);
        }
        debug(`Finished download of ${url} with ${err}`);
    };

    try {
        await fileExists(resumeFilePath);
    } catch (err) {
        return await download(downloadFilePath, url, onStart, onEnd);
    }

    try {
        await fileReadWritable(resumeFilePath);
    } catch (err) {
        debug(`Cannot read/write ${resumeFilePath}. Creating anew.`);
        return startOrResumeDownload(url, dir, `${downloadFileName}-1`);
    }

    await download(resumeFilePath, null, onStart, onEnd);
};

async function init() {
    const { url, dir } = argv;

    if (!(url && dir))
        return messageAndExit({ code: 'EBADPARAMS' });

    const tempDirPath = path.join(dir, ' ./temp');
    try {
        await mkdirp(tempDirPath);
    } catch (err) {
        return messageAndExit({ code: 'EMAKEDIRFAIL' });
    }

    await startOrResumeDownload(url, dir);
};

init();
