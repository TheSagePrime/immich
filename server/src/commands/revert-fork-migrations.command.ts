import { Command, CommandRunner, Option } from 'nest-commander';
import { OFFICIAL_BASELINE_MIGRATION } from 'src/constants.js';
import { CliService } from 'src/services/cli.service.js';

type RevertForkMigrationsOptions = {
  dryRun?: boolean;
};

@Command({
  name: 'revert-fork-migrations',
  description: `Revert every database migration newer than the official baseline (${OFFICIAL_BASELINE_MIGRATION})`,
})
export class RevertForkMigrationsCommand extends CommandRunner {
  constructor(private service: CliService) {
    super();
  }

  @Option({
    flags: '--dry-run',
    description: 'Only list the migrations that would be reverted',
  })
  parseDryRun(): boolean {
    return true;
  }

  async run(_: string[], options: RevertForkMigrationsOptions = {}): Promise<void> {
    try {
      const pending = await this.service.getForkMigrations();
      if (pending.length === 0) {
        console.log(`Nothing to revert, the database is already at ${OFFICIAL_BASELINE_MIGRATION}`);
        return;
      }

      if (options.dryRun) {
        console.log('The following migrations would be reverted, newest first:');
        for (const name of pending) {
          console.log(`  - ${name}`);
        }
        return;
      }

      const reverted = await this.service.revertForkMigrations();
      console.log('Reverted migrations, newest first:');
      for (const name of reverted) {
        console.log(`  - ${name}`);
      }
      console.log(`The database is now at ${OFFICIAL_BASELINE_MIGRATION}. Stop this container before it restarts.`);
    } catch (error) {
      console.error(error);
      console.error('Unable to revert fork migrations');
      process.exitCode = 1;
    }
  }
}
