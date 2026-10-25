import { StoreError } from "../core/errors.ts";

export interface Session {
  project: string;
  project_path?: string | null;
  branch?: string | null;
  pr?: string | null;
  org?: string | null;
}

/** Holds the project scope of one MCP connection: explicit set_context wins over auto-detection. */
export class SessionHolder {
  private current: Session | null = null;
  private readonly detect: (() => Session | null | Promise<Session | null>) | null;
  private readonly persist: ((session: Session) => void | Promise<void>) | null;

  constructor(
    detect: (() => Session | null | Promise<Session | null>) | null,
    persist: ((session: Session) => void | Promise<void>) | null = null,
  ) {
    this.detect = detect;
    this.persist = persist;
  }

  async get(): Promise<Session> {
    if (!this.current && this.detect) this.current = await this.detect();
    if (!this.current) throw new StoreError("invalid", "No project context. Call set_context first.");
    return this.current;
  }

  async set(next: Session): Promise<Session> {
    this.current = next;
    await this.persist?.(next);
    return next;
  }

  /** The auto-detected scope, ignoring any explicit override. */
  async detected(): Promise<Session | null> {
    return this.detect ? await this.detect() : null;
  }
}
