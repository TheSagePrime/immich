import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
import { RevertForkMigrationsCommand } from 'src/commands/revert-fork-migrations.command.js';
import { OFFICIAL_BASELINE_MIGRATION } from 'src/constants.js';
import { CliService } from 'src/services/cli.service.js';

describe(RevertForkMigrationsCommand.name, () => {
  let sut: RevertForkMigrationsCommand;
  let service: { getForkMigrations: ReturnType<typeof vitest.fn>; revertForkMigrations: ReturnType<typeof vitest.fn> };
  let log: ReturnType<typeof vitest.spyOn>;
  let errorLog: ReturnType<typeof vitest.spyOn>;

  beforeEach(() => {
    service = { getForkMigrations: vitest.fn(), revertForkMigrations: vitest.fn() };
    sut = new RevertForkMigrationsCommand(service as unknown as CliService);
    log = vitest.spyOn(console, 'log').mockImplementation(() => {});
    errorLog = vitest.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vitest.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should report when there is nothing to revert', async () => {
    service.getForkMigrations.mockResolvedValue([]);

    await sut.run([], {});

    expect(service.revertForkMigrations).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(OFFICIAL_BASELINE_MIGRATION));
  });

  it('should only list migrations in dry-run mode', async () => {
    service.getForkMigrations.mockResolvedValue(['1796000000000-ForkB', '1795000000000-ForkA']);

    await sut.run([], { dryRun: true });

    expect(service.revertForkMigrations).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('  - 1796000000000-ForkB');
    expect(log).toHaveBeenCalledWith('  - 1795000000000-ForkA');
  });

  it('should revert and list the reverted migrations', async () => {
    service.getForkMigrations.mockResolvedValue(['1795000000000-ForkA']);
    service.revertForkMigrations.mockResolvedValue(['1795000000000-ForkA']);

    await sut.run([], {});

    expect(service.revertForkMigrations).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('  - 1795000000000-ForkA');
    expect(process.exitCode).toBeUndefined();
  });

  it('should set a failing exit code when reverting fails', async () => {
    service.getForkMigrations.mockRejectedValue(new Error('baseline missing'));

    await sut.run([], {});

    expect(errorLog).toHaveBeenCalledWith('Unable to revert fork migrations');
    expect(process.exitCode).toBe(1);
  });

  it('should parse the dry-run flag', () => {
    expect(sut.parseDryRun()).toBe(true);
  });
});
