/**
 * AutoUpdater Entry Point
 */

const path = require('path');
const fork = require('child_process').fork();
const superagent = require('superagent');

function downloadUpdateFile(url, dir, onUpdateReady, onUpdateFail) {
    return new Promise((resolve, reject) => {
        const cp = fork(path.join(__dirname, './downloader'), [`--url=${url}`, `--dir=${dir}`], { execArgv: [`--inspect=${++lastDebugPort}`] });

        cp.once('message', message => {
            if (message.success && message.code == 'DOWNLOADSTARTED') {
                cp.once('message', message => {
                    if (message.success && message.code == 'DOWNLOADENDED')
                        return resolve(message.updateFilePath);

                    return reject(message);
                });
            }

            return reject(message);
        });
    });
};

async function updateIfAvailable(opts) {
    if (!(opts && opts.url && opts.shouldDownload && opts.getDownloadURL))
        throw new Error('Invalid update check url');

    let updateJSON;
    try {
        const update = await superagent.get(opts.url);
        updateJSON = JSON.parse(update);
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
        return await downloadUpdateFile(opts.getDownloadURL(updateJSON));
    }
};

module.exports = {
    updateIfAvailable
};
