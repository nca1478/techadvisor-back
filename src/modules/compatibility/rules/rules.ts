/**
 * Deterministic PC-component compatibility rules over product `specs`.
 *
 * Pure functions only: no database, no network, no LLM. Every rule reads
 * `specs` key/value pairs and returns findings; when the data needed for a
 * rule is missing, the rule emits a `warning` (never a silent pass). The
 * engine result is `compatible: true` only when there are zero issues of any
 * severity (see ADR 0034).
 */

import type {
  CompatibilityIssue,
  CompatibilityMessageKey,
  CompatibilityProduct,
  CompatibilityResult,
  CompatibilityRule,
  CompatibilitySeverity,
} from './compatibility.types.js';
import { renderCompatibilityMessage, type CompatibilityLocale } from './messages.js';

/** Base draw of board + RAM + drives + fans included in every estimate. */
export const PSU_BASE_LOAD_W = 100;
/** Required headroom over the estimated draw (20 %). See ADR 0034. */
export const PSU_HEADROOM_FACTOR = 1.2;

type Specs = Record<string, unknown>;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function norm(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeSocket(value: string): string {
  let compact = value
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, '');
  compact = compact.replace(/SOCKET/g, '').replace(/ZOCALO/g, '');
  if (compact.startsWith('FCLGA')) {
    return compact.slice('FCLGA'.length);
  }
  if (compact.startsWith('LGA')) {
    return compact.slice('LGA'.length);
  }
  if (compact.startsWith('PGA') || compact.startsWith('BGA')) {
    return compact.slice(3);
  }
  return compact;
}

function isOfCategory(product: CompatibilityProduct, slug: string): boolean {
  return product.categorySlug.trim().toLowerCase() === slug;
}

function makeIssue(
  rule: CompatibilityRule,
  severity: CompatibilitySeverity,
  productIds: string[],
  messageKey: CompatibilityMessageKey,
  locale: CompatibilityLocale,
  params: Record<string, string | number> = {},
): CompatibilityIssue {
  return {
    rule,
    severity,
    productIds: [...new Set(productIds)],
    messageKey,
    message: renderCompatibilityMessage(messageKey, locale, params),
  };
}

/** `NVME` → M.2; `SSD`/`HDD` → SATA; `form_factor` refines ambiguous cases. */
export function classifyStorageNeed(specs: Specs): 'M.2' | 'SATA' | null {
  const formFactor = asNonEmptyString(specs['form_factor']);
  if (formFactor !== undefined) {
    const lowered = formFactor.toLowerCase();
    if (lowered.includes('m.2') || lowered.includes('m2') || lowered.includes('nvme')) {
      return 'M.2';
    }
    if (
      lowered.includes('sata') ||
      lowered.includes('2.5') ||
      lowered.includes('3.5') ||
      lowered.includes('2,5')
    ) {
      return 'SATA';
    }
  }
  const storageType = asNonEmptyString(specs['storage_type']);
  if (storageType === undefined) {
    return null;
  }
  const normalizedType = norm(storageType);
  if (normalizedType === 'NVME') {
    return 'M.2';
  }
  if (normalizedType === 'SSD' || normalizedType === 'HDD') {
    return 'SATA';
  }
  return null;
}

/** Estimated draw in watts, or null when any contributor TDP is unknown. */
export function estimateDrawW(
  cpus: readonly CompatibilityProduct[],
  gpus: readonly CompatibilityProduct[],
): number | null {
  let total = PSU_BASE_LOAD_W;
  for (const product of [...cpus, ...gpus]) {
    const tdp = asNonNegativeInt(product.specs['tdp_w']);
    if (tdp === undefined) {
      return null;
    }
    total += tdp;
  }
  return total;
}

/** Minimum PSU wattage for an estimated draw (20 % headroom, rounded up). */
export function requiredPsuW(estimatedW: number): number {
  return Math.ceil(estimatedW * PSU_HEADROOM_FACTOR);
}

/**
 * Evaluates a set of products and returns every finding. Products are
 * expected to carry unique ids (the service dedupes); rule order and product
 * order are stable so output is deterministic.
 */
export function checkCompatibility(
  products: readonly CompatibilityProduct[],
  locale: CompatibilityLocale,
): CompatibilityResult {
  const issues: CompatibilityIssue[] = [];
  const cpus = products.filter((product) => isOfCategory(product, 'cpus'));
  const boards = products.filter((product) => isOfCategory(product, 'motherboards'));
  const rams = products.filter((product) => isOfCategory(product, 'ram'));
  const gpus = products.filter((product) => isOfCategory(product, 'gpus'));
  const drives = products.filter((product) => isOfCategory(product, 'storage'));
  const psus = products.filter((product) => isOfCategory(product, 'psus'));
  const laptops = products.filter((product) => isOfCategory(product, 'laptops'));

  if (boards.length > 1) {
    issues.push(
      makeIssue(
        'build-single-board',
        'error',
        boards.map((board) => board.id),
        'build-single-board.multiple',
        locale,
        { names: boards.map((board) => board.name).join(', ') },
      ),
    );
  }
  if (cpus.length > 1) {
    issues.push(
      makeIssue(
        'build-single-cpu',
        'error',
        cpus.map((cpu) => cpu.id),
        'build-single-cpu.multiple',
        locale,
        { names: cpus.map((cpu) => cpu.name).join(', ') },
      ),
    );
  }
  for (const laptop of laptops) {
    const others = products.filter(
      (product) => product.id !== laptop.id && !isOfCategory(product, 'laptops'),
    );
    if (others.length > 0) {
      issues.push(
        makeIssue(
          'build-laptop-mix',
          'warning',
          [laptop.id, ...others.map((product) => product.id)],
          'build-laptop-mix.mixed',
          locale,
          { laptop: laptop.name, names: others.map((product) => product.name).join(', ') },
        ),
      );
    }
  }

  // Pairwise board rules need exactly one board: with zero boards the
  // `build-needs-board` warning below covers the gap; with several, pairing
  // is ambiguous, so only the `build-single-board` error applies.
  const board = boards.length === 1 ? boards[0] : undefined;
  if (board === undefined) {
    if (boards.length === 0 && (cpus.length > 0 || rams.length > 0 || drives.length > 0)) {
      issues.push(
        makeIssue(
          'build-needs-board',
          'warning',
          [...cpus, ...rams, ...drives].map((product) => product.id),
          'build-needs-board.missing',
          locale,
        ),
      );
    }
  } else {
    issues.push(...checkCpuSocket(cpus, board, locale));
    issues.push(...checkRam(rams, board, locale));
    issues.push(...checkStorage(drives, board, locale));
  }

  issues.push(...checkPsu(cpus, gpus, psus, locale));

  return { compatible: issues.length === 0, issues };
}

function checkCpuSocket(
  cpus: readonly CompatibilityProduct[],
  board: CompatibilityProduct,
  locale: CompatibilityLocale,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const boardSocketRaw = asNonEmptyString(board.specs['socket']);
  for (const cpu of cpus) {
    const cpuSocketRaw = asNonEmptyString(cpu.specs['socket']);
    if (cpuSocketRaw === undefined || boardSocketRaw === undefined) {
      issues.push(
        makeIssue('cpu-socket', 'warning', [cpu.id, board.id], 'cpu-socket.missing-data', locale, {
          cpu: cpu.name,
          board: board.name,
        }),
      );
      continue;
    }
    const cpuKey = normalizeSocket(cpuSocketRaw);
    const boardKey = normalizeSocket(boardSocketRaw);
    if (cpuKey.length === 0 || boardKey.length === 0) {
      issues.push(
        makeIssue('cpu-socket', 'warning', [cpu.id, board.id], 'cpu-socket.missing-data', locale, {
          cpu: cpu.name,
          board: board.name,
        }),
      );
      continue;
    }
    if (cpuKey !== boardKey) {
      issues.push(
        makeIssue('cpu-socket', 'error', [cpu.id, board.id], 'cpu-socket.mismatch', locale, {
          cpu: cpu.name,
          cpuSocket: cpuSocketRaw.trim(),
          board: board.name,
          boardSocket: boardSocketRaw.trim(),
        }),
      );
    }
  }
  return issues;
}

function checkRam(
  rams: readonly CompatibilityProduct[],
  board: CompatibilityProduct,
  locale: CompatibilityLocale,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const boardTypeRaw = asNonEmptyString(board.specs['ram_type']);

  for (const ram of rams) {
    const ramTypeRaw = asNonEmptyString(ram.specs['ram_type']);
    if (ramTypeRaw === undefined || boardTypeRaw === undefined) {
      issues.push(
        makeIssue('ram-type', 'warning', [ram.id, board.id], 'ram-type.missing-data', locale, {
          ram: ram.name,
          board: board.name,
        }),
      );
    } else if (norm(ramTypeRaw) !== norm(boardTypeRaw)) {
      issues.push(
        makeIssue('ram-type', 'error', [ram.id, board.id], 'ram-type.mismatch', locale, {
          ram: ram.name,
          ramType: ramTypeRaw.trim(),
          board: board.name,
          boardType: boardTypeRaw.trim(),
        }),
      );
    }
  }

  if (rams.length > 0) {
    const maxGb = asNonNegativeInt(board.specs['max_ram_gb']);
    const capacities = rams.map((ram) => asNonNegativeInt(ram.specs['ram_gb']));
    if (maxGb === undefined || capacities.some((capacity) => capacity === undefined)) {
      issues.push(
        makeIssue(
          'ram-capacity',
          'warning',
          [board.id, ...rams.map((ram) => ram.id)],
          'ram-capacity.missing-data',
          locale,
          { board: board.name },
        ),
      );
    } else {
      const totalGb = capacities.reduce<number>((sum, capacity) => sum + (capacity ?? 0), 0);
      if (totalGb > maxGb) {
        issues.push(
          makeIssue(
            'ram-capacity',
            'error',
            [board.id, ...rams.map((ram) => ram.id)],
            'ram-capacity.exceeded',
            locale,
            { board: board.name, totalGb, maxGb },
          ),
        );
      }
    }

    const slots = asNonNegativeInt(board.specs['ram_slots']);
    // A kit without a `modules` key counts as a single stick; anything else
    // (missing board slots) warns instead of guessing.
    const modules = rams.map((ram) => {
      const raw = ram.specs['modules'];
      return raw === undefined ? 1 : asNonNegativeInt(raw);
    });
    if (slots === undefined || modules.some((count) => count === undefined)) {
      issues.push(
        makeIssue(
          'ram-slots',
          'warning',
          [board.id, ...rams.map((ram) => ram.id)],
          'ram-slots.missing-data',
          locale,
          { board: board.name },
        ),
      );
    } else {
      const needSlots = modules.reduce<number>((sum, count) => sum + (count ?? 0), 0);
      if (needSlots > slots) {
        issues.push(
          makeIssue(
            'ram-slots',
            'error',
            [board.id, ...rams.map((ram) => ram.id)],
            'ram-slots.exceeded',
            locale,
            { board: board.name, needSlots, slots },
          ),
        );
      }
    }

    const maxSpeed = asNonNegativeInt(board.specs['max_ram_speed_mt_s']);
    const speeds = rams.map((ram) => ({
      ram,
      speed: asNonNegativeInt(ram.specs['speed_mt_s']),
    }));
    if (maxSpeed === undefined || speeds.some((entry) => entry.speed === undefined)) {
      issues.push(
        makeIssue(
          'ram-speed',
          'warning',
          [board.id, ...rams.map((ram) => ram.id)],
          'ram-speed.missing-data',
          locale,
          { board: board.name },
        ),
      );
    } else {
      // Faster-than-board memory still works at a lower speed: warning, not error.
      for (const entry of speeds) {
        if ((entry.speed ?? 0) > maxSpeed) {
          issues.push(
            makeIssue(
              'ram-speed',
              'warning',
              [entry.ram.id, board.id],
              'ram-speed.exceeded',
              locale,
              {
                ram: entry.ram.name,
                speed: entry.speed ?? 0,
                board: board.name,
                maxSpeed,
              },
            ),
          );
        }
      }
    }
  }

  return issues;
}

function checkStorage(
  drives: readonly CompatibilityProduct[],
  board: CompatibilityProduct,
  locale: CompatibilityLocale,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (drives.length === 0) {
    return issues;
  }
  const m2Slots = asNonNegativeInt(board.specs['m2_slots']);
  const sataPorts = asNonNegativeInt(board.specs['sata_ports']);

  const needs = drives.map((drive) => ({ drive, need: classifyStorageNeed(drive.specs) }));
  const unknown = needs.filter((entry) => entry.need === null);
  for (const entry of unknown) {
    issues.push(
      makeIssue(
        'storage-interface',
        'warning',
        [entry.drive.id, board.id],
        'storage-interface.missing-data',
        locale,
        { drive: entry.drive.name, board: board.name },
      ),
    );
  }

  const m2Drives = needs.filter((entry) => entry.need === 'M.2').map((entry) => entry.drive);
  const sataDrives = needs.filter((entry) => entry.need === 'SATA').map((entry) => entry.drive);
  if (m2Drives.length > 0 && m2Slots === undefined) {
    issues.push(
      makeIssue(
        'storage-interface',
        'warning',
        [board.id, ...m2Drives.map((drive) => drive.id)],
        'storage-interface.missing-data',
        locale,
        { drive: m2Drives[0]?.name ?? '', board: board.name },
      ),
    );
  } else {
    m2Drives.forEach((drive, index) => {
      if (index >= (m2Slots ?? 0)) {
        issues.push(
          makeIssue(
            'storage-interface',
            'error',
            [drive.id, board.id],
            'storage-interface.unsupported',
            locale,
            { drive: drive.name, need: 'M.2', board: board.name },
          ),
        );
      }
    });
  }
  if (sataDrives.length > 0 && sataPorts === undefined) {
    issues.push(
      makeIssue(
        'storage-interface',
        'warning',
        [board.id, ...sataDrives.map((drive) => drive.id)],
        'storage-interface.missing-data',
        locale,
        { drive: sataDrives[0]?.name ?? '', board: board.name },
      ),
    );
  } else {
    sataDrives.forEach((drive, index) => {
      if (index >= (sataPorts ?? 0)) {
        issues.push(
          makeIssue(
            'storage-interface',
            'error',
            [drive.id, board.id],
            'storage-interface.unsupported',
            locale,
            { drive: drive.name, need: 'SATA', board: board.name },
          ),
        );
      }
    });
  }
  return issues;
}

function checkPsu(
  cpus: readonly CompatibilityProduct[],
  gpus: readonly CompatibilityProduct[],
  psus: readonly CompatibilityProduct[],
  locale: CompatibilityLocale,
): CompatibilityIssue[] {
  if (cpus.length === 0 && gpus.length === 0) {
    return [];
  }
  if (psus.length === 0) {
    return [
      makeIssue(
        'build-needs-psu',
        'warning',
        [...cpus, ...gpus].map((product) => product.id),
        'build-needs-psu.missing',
        locale,
      ),
    ];
  }
  // A build uses a single supply: evaluate the strongest candidate. A weaker
  // extra unit in the same check never fails the whole build.
  const withWattage = psus.map((psu) => ({
    psu,
    wattage: asNonNegativeInt(psu.specs['wattage_w']),
  }));
  if (withWattage.some((entry) => entry.wattage === undefined)) {
    return [
      makeIssue(
        'psu-wattage',
        'warning',
        [...psus, ...cpus, ...gpus].map((product) => product.id),
        'psu-wattage.missing-data',
        locale,
      ),
    ];
  }
  const estimated = estimateDrawW(cpus, gpus);
  if (estimated === null) {
    return [
      makeIssue(
        'psu-wattage',
        'warning',
        [...psus, ...cpus, ...gpus].map((product) => product.id),
        'psu-wattage.missing-data',
        locale,
      ),
    ];
  }
  const strongest = withWattage.reduce((best, entry) =>
    (entry.wattage ?? 0) > (best.wattage ?? 0) ? entry : best,
  );
  const required = requiredPsuW(estimated);
  if ((strongest.wattage ?? 0) < required) {
    return [
      makeIssue(
        'psu-wattage',
        'error',
        [strongest.psu.id, ...cpus.map((cpu) => cpu.id), ...gpus.map((gpu) => gpu.id)],
        'psu-wattage.insufficient',
        locale,
        {
          psu: strongest.psu.name,
          wattage: strongest.wattage ?? 0,
          required,
          estimated,
        },
      ),
    ];
  }
  return [];
}
