/**
 * AutoUpdater Entry Point
 */

const path = require('path');
const debug = require('debug')('au:index');
const fork = require('child_process').fork;
const superagent = require('superagent');
const { promisify } = require('util');
const untar = promisify(require('targz').decompress);
const unlink = promisify(require('fs').unlink);

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

    const shouldDownload = opts.shouldDownload(updateJSON);
    if (shouldDownload instanceof Promise ? await shouldDownload : shouldDownload) {
        let updateFilePath;
        const downloadURL = opts.getDownloadURL(updateJSON);

        try {
            updateFilePath = await downloadUpdateFile(downloadURL, opts.dir, opts.getChecksum(updateJSON));
            await untar({
                src: updateFilePath,
                dest: opts.extractDir
            });
        } catch (err) {
            if (updateFilePath)
                await unlink(updateFilePath);

            debug(`Failed to download and extract ${downloadURL}. Deleting downloaded file.`);
            throw err;
        }
    }
};

/*
async function test() {
    const downloadFilePath = await updateIfAvailable({
        shouldDownload: () => true,
        dir: path.join(__dirname, './tmp'),
        url: 'http://localhost:3002/update.json',
        getDownloadURL: manifest => manifest.url,
        extractDir: path.join(__dirname, './tmp'),
        getChecksum: manifest => manifest.checksum
    });
};
*/

test();

module.exports = {
    updateIfAvailable
};
