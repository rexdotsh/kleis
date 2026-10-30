export class DependencyError extends Error {
  constructor(
    readonly dependency: "db" | "upstream" | "models.dev",
    cause: unknown
  ) {
    super(`${dependency} request failed`, { cause });
    this.name = "DependencyError";
  }
}
