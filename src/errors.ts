/** The iroh mesh layer could not be brought up (missing addon, unsupported
 * platform, wrong build). The Jazz server itself still works without it. */
export class MeshUnavailableError extends Error {
  constructor(reason: string) {
    super(`iroh mesh unavailable: ${reason}`);
    this.name = "MeshUnavailableError";
  }
}
