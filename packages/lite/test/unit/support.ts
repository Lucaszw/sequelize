import { PGlite } from '@electric-sql/pglite';
import { Sequelize } from '@sequelize/lite';

export async function createSequelize(
  options: Partial<ConstructorParameters<typeof Sequelize>[0]> = {},
) {
  return new Sequelize({ pglite: new PGlite(), ...options });
}

export async function expectRejection(
  promise: Promise<unknown>,
  matcher: RegExp | (new (...args: any[]) => Error),
) {
  try {
    await promise;
  } catch (error) {
    if (matcher instanceof RegExp) {
      if (!matcher.test((error as Error).message)) {
        throw new Error(`Expected error matching ${matcher}, got: ${(error as Error).message}`);
      }
    } else if (!(error instanceof matcher)) {
      throw new Error(`Expected ${matcher.name}, got: ${String(error)}`);
    }

    return error;
  }

  throw new Error('Expected promise to reject');
}
