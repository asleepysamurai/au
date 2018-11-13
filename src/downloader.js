/**
 * Given a url and a directory,
 * downloads the tar file at that url
 * Once downloaded untars the tar file
 * into specified directory.
 *
 * Can resume downloads.
 */

const argv = require('minimist')(process.argv.slice(2));
const mkdirp = require('make-dir');
const path = require('path');
const FD = require('fast-download');
const fs = require('fs');
const { promisify } = require('util');
const getChecksum = promisify(require('checksum').file);

const debug = require('./debug')('au:downloader');

const access = promisify(fs.access);
const unlink = promisify(fs.unlink);

function messageAndExit(message, success = true, dontExit) {
    message.success = success;

    if (process.send)
        process.send(message);
    else
        debug(message);

    if (!dontExit)
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

function startOrResumeDownload(url, dir, checksum) {
    return new Promise(async (resolve, reject) => {
        const downloadFileName = path.basename(url);

        const downloadFilePath = path.resolve(dir, downloadFileName);

        function onStart() {
            debug(`Starting download of ${url} to ${downloadFilePath}`);
            return messageAndExit({ code: 'DOWNLOADSTARTED' }, true, true);
        };

        async function onEnd(err) {
            if (err) {
                debug(`Error while downloading update: ${err.message}`);
                return reject(err);
            }

            debug(`Finished download of ${url}`);

            const fileChecksum = await getChecksum(downloadFilePath, { algorithm: 'sha256' });
            debug(`File checksum: ${fileChecksum}`);
            if (fileChecksum == checksum) {
                return resolve(downloadFilePath);
            } else {
                await unlink(downloadFilePath);
                let err = new Error('Checksum mismatch. Deleted downloaded file.');
                err.code = 'EBADCHECKSUM';
                return reject(err);
            }
        };

        await download(downloadFilePath, url, onStart, onEnd);
    });
};

async function init() {
    const { url, dir, checksum } = argv;

    if (!(url && dir && checksum))
        return messageAndExit({ code: 'EBADPARAMS' }, false);

    const tempDirPath = path.join(dir, ' ./temp');
    try {
        await mkdirp(tempDirPath);
    } catch (err) {
        return messageAndExit({ code: 'EMAKEDIRFAIL' }, false);
    }

    try {
        const updateFilePath = await startOrResumeDownload(url, dir, checksum);
        return messageAndExit({ code: 'DOWNLOADENDED', updateFilePath }, true);
    } catch (err) {
        return messageAndExit({ code: err.code, message: err.message }, false);
    }
};

init();
