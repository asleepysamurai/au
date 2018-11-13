/**
 * Debug Helper
 *
 * Automatically sets useColors to false in production
 * to prevent logging ANSI codes to log file
 */

module.exports = (namespace) => {
    let debug = require('debug')(namespace);
    debug.useColors = process.env.NODE_ENV == 'development';

    return debug;
};
