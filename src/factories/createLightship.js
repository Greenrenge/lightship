// @flow

import express from 'express';
import serializeError from 'serialize-error';
import Logger from '../Logger';
import type {
  ConfigurationType,
  LightshipType,
  ShutdownHandlerType,
  UserConfigurationType
} from '../types';
import {
  SERVER_IS_NOT_READY,
  SERVER_IS_NOT_SHUTTING_DOWN,
  SERVER_IS_READY,
  SERVER_IS_SHUTTING_DOWN
} from '../states';

const log = Logger.child({
  namespace: 'factories/createLightship'
});

const defaultConfiguration = {
  port: 9000,
  signals: [
    'SIGTERM',
    'SIGHUP',
    'SIGINT'
  ],
  timeout: 60000
};

export default (userConfiguration?: UserConfigurationType): LightshipType => {
  const shutdownHandlers: Array<ShutdownHandlerType> = [];

  const configuration: ConfigurationType = {
    ...defaultConfiguration,
    ...userConfiguration
  };

  let serverIsReady = false;
  let serverIsShuttingDown = false;

  const app = express();

  const server = app.listen(configuration.port);

  app.get('/health', (request, response) => {
    if (serverIsShuttingDown) {
      response.status(500).send(SERVER_IS_SHUTTING_DOWN);
    } else if (serverIsReady) {
      response.send(SERVER_IS_READY);
    } else {
      response.status(500).send(SERVER_IS_NOT_READY);
    }
  });

  app.get('/live', (request, response) => {
    if (serverIsShuttingDown) {
      response.status(500).send(SERVER_IS_SHUTTING_DOWN);
    } else {
      response.send(SERVER_IS_NOT_SHUTTING_DOWN);
    }
  });

  app.get('/ready', (request, response) => {
    if (serverIsReady) {
      response.send(SERVER_IS_READY);
    } else {
      response.status(500).send(SERVER_IS_NOT_READY);
    }
  });

  const signalNotReady = () => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    if (serverIsReady === false) {
      log.warn('server is already in a SERVER_IS_NOT_READY state');
    }

    log.info('signaling that the server is not ready to accept connections');

    serverIsReady = false;
  };

  const signalReady = () => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    log.info('signaling that the server is ready');

    serverIsReady = true;
  };

  const shutdown = async () => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    log.info('received request to shutdown the service');

    if (configuration.timeout !== Infinity) {
      setTimeout(() => {
        log.warn('timeout occured before all the shutdown handlers could run to completion; forcing termination');

        // eslint-disable-next-line no-process-exit
        process.exit(1);
      }, configuration.timeout);
    }

    serverIsReady = false;
    serverIsShuttingDown = true;

    for (const shutdownHandler of shutdownHandlers) {
      try {
        await shutdownHandler();
      } catch (error) {
        log.error({
          error: serializeError(error)
        }, 'shutdown handler produced an error');
      }
    }

    log.debug('all shutdown handlers have run to completion; proceeding to terminate the Node.js process');

    server.close((error) => {
      if (error) {
        log.error({
          error: serializeError(error)
        }, 'server was terminated with an error');
      }

      const timeoutId = setTimeout(() => {
        log.warn('process did not exit on its own; invetigate what is keeping the event loop active');

        // eslint-disable-next-line no-process-exit
        process.exit(1);
      }, 1000);

      // $FlowFixMe
      timeoutId.unref();
    });
  };

  for (const signal of configuration.signals) {
    process.on(signal, () => {
      log.debug({
        signal
      }, 'received a shutdown signal');

      shutdown();
    });
  }

  return {
    isServerReady: () => {
      return serverIsReady;
    },
    isServerShuttingDown: () => {
      return serverIsShuttingDown;
    },
    registerShutdownHandler: (shutdownHandler) => {
      shutdownHandlers.push(shutdownHandler);
    },
    shutdown,
    signalNotReady,
    signalReady
  };
};
