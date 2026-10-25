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
  private readonly detect: (() => Session) | null;

  constructor(detect: (() => Session) | null) {
    this.detect = detect;
  }

  get(): Session {
    if (!this.current && this.detect) this.current = this.detect();
    if (!this.current) throw new StoreError("invalid", "No project context. Call set_context first.");
    return this.current;
  }

  set(next: Session): Session {
    this.current = next;
    return next;
  }

  /** The auto-detected scope, ignoring any explicit override. */
  detected(): Session | null {
    return this.detect ? this.detect() : null;
  }
}
