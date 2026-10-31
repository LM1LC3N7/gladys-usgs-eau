// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app: used by index.js and by the tests (so
// that the tests go through the same wiring). Every handler is registered
// before connect(). Read-only: no command handler.
// -----------------------------------------------------------------------------

import { SHUTDOWN_LIMIT } from './constants.js';

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {import('./app.js').WaterApp} app
 */
export function wire(gladys, app, logger, { exit = process.exit, timers = { setTimeout } } = {}) {
  // --- Discovery -----------------------------------------------------------------
  // The stations already read, never a read (the next one comes at its time).
  gladys.onScanRequest(() => app.scan());
  // A device created gets the current values in memory at once (never a read).
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));
  gladys.onDeviceDeleted((device) => app.onDeviceDeleted(device));

  // --- Configuration screen button: search the stations by name -------------------
  gladys.onAction('search_stations', (fields) => app.search(fields));

  // --- Configuration changed by the user ------------------------------------------
  gladys.onConfigUpdated((config) => {
    logger.info('Configuration updated');
    return app.configUpdated(config);
  });

  // --- Connection lifecycle --------------------------------------------------------
  // Every connection (the first one and each reconnection) reads the
  // configuration (tried again without end while Gladys cannot give it), then
  // publishes the Discovery list and the status again; the reads keep their
  // pace (never sooner than the interval after the last one).
  gladys.on('connected', () => {
    app
      .connected(() => gladys.getConfig())
      .catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
  });
  gladys.on('disconnected', () => {
    app.disconnected().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
  // The supervisor stops the container: the app stops (the read running
  // awaited STOP_WAIT at most, then the save of /data SAVE_WAIT at most), then
  // the SDK disconnects and exits. Whatever else holds the stop back (a stop
  // queued behind a start, a Gladys that never answers the close), the
  // process exits SHUTDOWN_LIMIT after the signal, before Docker's SIGKILL.
  // Nothing can hold the exit itself on a FIFO of /data: the store never
  // opens a file in a way that blocks (src/store.js). A mount of /data frozen
  // in the kernel is the one case left to Docker's SIGKILL.
  gladys.handleShutdown(() => {
    const timer = timers.setTimeout(() => exit(0), SHUTDOWN_LIMIT);
    timer?.unref?.();
    return app.stop();
  });
}
