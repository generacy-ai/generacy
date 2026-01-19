/**
 * Public exports for connections module.
 */

export {
  ConnectionRegistry,
  ConnectionExistsError,
  ConnectionNotFoundError,
  type ConnectionRegistryEvents,
} from './connection-registry.js';

export {
  createAgencyConnection,
  createMockAgencyConnection,
  type AgencyConnectionOptions,
} from './agency-connection.js';

export {
  createHumancyConnection,
  createMockHumancyConnection,
  type HumancyConnectionOptions,
} from './humancy-connection.js';
