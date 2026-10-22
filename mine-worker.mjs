// Proof-of-work search off the node event loop. The parent passes the header hash and difficulty.
import { parentPort, workerData } from 'worker_threads';
import { findNonce } from './zakchain.mjs';

try { parentPort.postMessage(findNonce(workerData.hh, workerData.bits)); }
catch (e) { parentPort.postMessage({ error: e.message }); }
