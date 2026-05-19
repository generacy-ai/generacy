export function setupErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    console.error(`Error: ${error.message}`);
    if (process.env['DEBUG'] === '1') {
      console.error(error.stack);
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`Error: ${message}`);
    if (process.env['DEBUG'] === '1' && reason instanceof Error) {
      console.error(reason.stack);
    }
    process.exit(1);
  });
}
