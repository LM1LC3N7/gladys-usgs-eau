// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app: used by index.js and by the tests (so
// that the tests go through the same wiring). Every handler is registered
// before connect(). Read-only: no command handler.
// -----------------------------------------------------------------------------

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {import('./app.js').WaterApp} app
 */
export function wire(gladys, app, logger) {
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
  gladys.handleShutdown(() => app.stop());
}
