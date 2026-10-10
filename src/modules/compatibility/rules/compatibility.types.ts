/**
 * Pure input/output types of the deterministic compatibility engine.
 *
 * The engine never touches the database, the network or any LLM: it only
 * reads `specs` key/value pairs from the products it receives. I/O (SQL
 * hydration) lives in `CompatibilityService`; message rendering lives in
 * `messages.ts`.
 */

export type CompatibilitySeverity = 'error' | 'warning';

/** Rule identifiers emitted by the engine (see ADR 0034). */
export type CompatibilityRule =
  | 'cpu-socket'
  | 'ram-type'
  | 'ram-capacity'
  | 'ram-slots'
  | 'ram-speed'
  | 'storage-interface'
  | 'psu-wattage'
  | 'build-single-board'
  | 'build-single-cpu'
  | 'build-needs-board'
  | 'build-needs-psu'
  | 'build-laptop-mix';

/** i18n keys for rule messages (one key per outcome, `es` + `en`). */
export type CompatibilityMessageKey =
  | 'cpu-socket.mismatch'
  | 'cpu-socket.missing-data'
  | 'ram-type.mismatch'
  | 'ram-type.missing-data'
  | 'ram-capacity.exceeded'
  | 'ram-capacity.missing-data'
  | 'ram-slots.exceeded'
  | 'ram-slots.missing-data'
  | 'ram-speed.exceeded'
  | 'ram-speed.missing-data'
  | 'storage-interface.unsupported'
  | 'storage-interface.missing-data'
  | 'psu-wattage.insufficient'
  | 'psu-wattage.missing-data'
  | 'build-single-board.multiple'
  | 'build-single-cpu.multiple'
  | 'build-needs-board.missing'
  | 'build-needs-psu.missing'
  | 'build-laptop-mix.mixed';

/** Minimal product view the engine needs: id + category + raw specs. */
export interface CompatibilityProduct {
  id: string;
  name: string;
  categorySlug: string;
  specs: Record<string, unknown>;
}

/** One finding of the engine. */
export interface CompatibilityIssue {
  rule: CompatibilityRule;
  severity: CompatibilitySeverity;
  productIds: string[];
  messageKey: CompatibilityMessageKey;
  /** Human-readable message in the requested locale (params applied). */
  message: string;
}

/** Engine result: `compatible` is true only when there are zero issues. */
export interface CompatibilityResult {
  compatible: boolean;
  issues: CompatibilityIssue[];
}
