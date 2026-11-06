#!/usr/bin/env node

/**
 * Simple interactive log viewer for Scribe logs
 * Usage: node scripts/view-logs.js [logfile]
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');

const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
};

const logFile = process.argv[2] || path.join(process.cwd(), 'logs', 'app.log');

if (!fs.existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    console.error('Usage: node scripts/view-logs.js [logfile]');
    process.exit(1);
}

function colorizeLevel(level) {
    const levels = {
        error: colors.red,
        warn: colors.yellow,
        info: colors.green,
        debug: colors.blue,
        trace: colors.gray,
    };
    return (levels[level] || '') + level.toUpperCase().padEnd(5) + colors.reset;
}

function formatLog(line) {
    try {
        const log = JSON.parse(line);
        const timestamp = new Date(log.time).toLocaleString();
        const level = colorizeLevel(log.level);
        const msg = log.msg || '';
        
        // Extract key fields
        const context = [];
        if (log.requestId) context.push(`reqId=${log.requestId.slice(0, 12)}`);
        if (log.socketId) context.push(`socket=${log.socketId.slice(0, 8)}`);
        if (log.userId) context.push(`user=${log.userId.slice(0, 8)}`);
        if (log.userEmail) context.push(`email=${log.userEmail}`);
        if (log.duration !== undefined) context.push(`${log.duration}ms`);
        if (log.statusCode) context.push(`status=${log.statusCode}`);
        
        const contextStr = context.length > 0 ? colors.cyan + ' [' + context.join(', ') + ']' + colors.reset : '';
        
        let output = `${colors.gray}${timestamp}${colors.reset} ${level} ${msg}${contextStr}`;
        
        // Show error details
        if (log.error) {
            output += `\n  ${colors.red}Error: ${log.error}${colors.reset}`;
        }
        
        // Show additional interesting fields
        const exclude = ['time', 'level', 'msg', 'pid', 'hostname', 'service', 'env', 'requestId', 'socketId', 'userId', 'userEmail', 'duration', 'statusCode', 'error', 'stack'];
        const extra = Object.keys(log).filter(k => !exclude.includes(k));
        if (extra.length > 0) {
            const extraData = extra.map(k => `${k}=${JSON.stringify(log[k])}`).join(', ');
            output += `\n  ${colors.gray}${extraData}${colors.reset}`;
        }
        
        return output;
    } catch (e) {
        return colors.gray + line + colors.reset;
    }
}

async function tailLogs(follow = false) {
    const fileStream = fs.createReadStream(logFile);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        console.log(formatLog(line));
    }

    if (follow) {
        console.log(colors.gray + '\nWatching for new logs...' + colors.reset);
        fs.watchFile(logFile, () => {
            const newStream = fs.createReadStream(logFile);
            const newRl = readline.createInterface({
                input: newStream,
                crlfDelay: Infinity,
            });
            newRl.on('line', (line) => {
                console.log(formatLog(line));
            });
        });
    }
}

// Check for flags
const follow = process.argv.includes('-f') || process.argv.includes('--follow');

console.log(colors.cyan + `\nViewing logs from: ${logFile}` + colors.reset);
console.log(colors.gray + '─'.repeat(80) + colors.reset + '\n');

tailLogs(follow).catch(console.error);
