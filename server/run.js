// Keeps the earpiece server running and switches between its two modes:
//   standby   — nothing is recorded; prepare the next session (this is how it starts)
//   recording — a session is being recorded
// The server exits with 76 for "Start session" and 75 for "End session"; this starts it again in the new mode.
// If it crashes it comes back in the same mode (a crash while recording starts a new session folder).
// START_RECORDING=1 npm start  skips standby and records straight away.
const { spawn } = require('child_process');
const path = require('path');
let child, stopping = false, first = true;

function start(mode) {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit', env: { ...process.env, EARPIECE_MODE: mode, ...(first ? {} : { NO_OPEN: '1' }) }
  });
  first = false;
  child.on('exit', (code) => {
    if (stopping) return process.exit(0);
    if (code === 76) return start('record');
    if (code === 75) { console.log('\n  — session saved; standby —\n'); return start('standby'); }
    if (code !== 0) { console.log(`\n  ! the server stopped unexpectedly (code ${code}) — restarting in 2 s\n`); return setTimeout(() => start(mode), 2000); }
    process.exit(0);
  });
}
process.on('SIGINT', () => { stopping = true; try { child.kill('SIGINT'); } catch {} });
process.on('SIGTERM', () => { stopping = true; try { child.kill('SIGTERM'); } catch {} });
start(process.env.START_RECORDING === '1' ? 'record' : 'standby');
