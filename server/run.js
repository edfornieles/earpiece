// Starts the server, and starts it again with a fresh session folder whenever
// "End session" is pressed in the control room. Ctrl+C stops everything.
const { spawn } = require('child_process');
const path = require('path');
let child, stopping = false, first = true;
function start() {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit', env: { ...process.env, ...(first ? {} : { NO_OPEN: '1' }) } });
  first = false;
  child.on('exit', (code) => {
    if (stopping) return process.exit(0);
    if (code === 75) { console.log('\n  — new session —\n'); return start(); }
    if (code !== 0) { console.log(`\n  ! the server stopped unexpectedly (code ${code}) — restarting in 2 s\n`); return setTimeout(start, 2000); }
    process.exit(0);
  });
}
process.on('SIGINT', () => { stopping = true; try { child.kill('SIGINT'); } catch {} });   // the server finishes its recordings, then we exit
process.on('SIGTERM', () => { stopping = true; child.kill('SIGTERM'); });
start();
