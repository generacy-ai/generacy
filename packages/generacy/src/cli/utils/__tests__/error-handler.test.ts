import { setupErrorHandlers } from '../error-handler.js';

describe('setupErrorHandlers', () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let savedDebug: string | undefined;

  beforeEach(() => {
    savedDebug = process.env['DEBUG'];
    delete process.env['DEBUG'];

    processOnSpy = vi.spyOn(process, 'on');
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();

    if (savedDebug !== undefined) {
      process.env['DEBUG'] = savedDebug;
    } else {
      delete process.env['DEBUG'];
    }
  });

  it('should register handlers for uncaughtException and unhandledRejection', () => {
    setupErrorHandlers();

    const registeredEvents = processOnSpy.mock.calls.map((call) => call[0]);
    expect(registeredEvents).toContain('uncaughtException');
    expect(registeredEvents).toContain('unhandledRejection');
  });

  describe('uncaughtException handler', () => {
    function getUncaughtExceptionHandler(): (error: Error) => void {
      setupErrorHandlers();
      const call = processOnSpy.mock.calls.find(
        (c) => c[0] === 'uncaughtException',
      );
      return call![1] as (error: Error) => void;
    }

    it('should print user-friendly message', () => {
      const handler = getUncaughtExceptionHandler();
      const error = new Error('something went wrong');

      handler(error);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error: something went wrong',
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should print stack trace when DEBUG=1', () => {
      process.env['DEBUG'] = '1';
      const handler = getUncaughtExceptionHandler();
      const error = new Error('debug error');

      handler(error);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: debug error');
      expect(consoleErrorSpy).toHaveBeenCalledWith(error.stack);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should NOT print stack trace when DEBUG is not 1', () => {
      delete process.env['DEBUG'];
      const handler = getUncaughtExceptionHandler();
      const error = new Error('no debug');

      handler(error);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: no debug');
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(error.stack);
    });
  });

  describe('unhandledRejection handler', () => {
    function getUnhandledRejectionHandler(): (reason: unknown) => void {
      setupErrorHandlers();
      const call = processOnSpy.mock.calls.find(
        (c) => c[0] === 'unhandledRejection',
      );
      return call![1] as (reason: unknown) => void;
    }

    it('should handle Error reason', () => {
      const handler = getUnhandledRejectionHandler();
      const error = new Error('rejected promise');

      handler(error);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: rejected promise');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle non-Error reason', () => {
      const handler = getUnhandledRejectionHandler();

      handler('string reason');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: string reason');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
