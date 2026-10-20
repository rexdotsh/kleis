import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

// libSQL transactions take their connection with them, and the next ":memory:"
// connection is a new, empty database, so tests that write in a transaction
// use a throwaway file instead.
export const createTempDatabaseUrl = () => {
  const path = `${tmpdir()}/kleis-test-${crypto.randomUUID()}.db`;
  return {
    url: `file:${path}`,
    remove(): void {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    },
  };
};
