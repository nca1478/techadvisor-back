import { describe, expect, it } from 'vitest';
import type {
  CompatibilityProduct,
  CompatibilityResult,
  CompatibilityRule,
} from './compatibility.types.js';
import { resolveCompatibilityLocale } from './messages.js';
import { checkCompatibility, classifyStorageNeed, estimateDrawW, requiredPsuW } from './rules.js';

/**
 * Unit tests for the deterministic compatibility engine (see ADR 0034).
 *
 * Fixtures mirror real seed rows by SKU (socket, RAM type, TDPs, wattages and
 * drive interfaces come from `prisma/seed-data/products.json`). Seed
 * motherboards predate `max_ram_speed_mt_s`/`m2_slots`/`sata_ports`, so the
 * "enriched" board fixtures below add realistic values for those keys, while
 * dedicated missing-data tests use the raw seed shape (without them).
 */

let counter = 0;

function product(
  categorySlug: string,
  name: string,
  specs: Record<string, unknown>,
): CompatibilityProduct {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    name,
    categorySlug,
    specs,
  };
}

// --- Seed mirrors ------------------------------------------------------------
// AMD-R5-7600 (AM5, 65W) / INT-I5-13400F (LGA1700, 65W) / INT-I7-14700K (125W).
const ryzen57600 = () => product('cpus', 'AMD Ryzen 5 7600', { socket: 'AM5', tdp_w: 65 });
const i513400F = () => product('cpus', 'Intel Core i5-13400F', { socket: 'LGA1700', tdp_w: 65 });
const i714700K = () => product('cpus', 'Intel Core i7-14700K', { socket: 'LGA1700', tdp_w: 125 });

// MSI-B650-TOMAHAWK-WIFI (AM5, DDR5, 4 slots, 128GB) — raw seed shape: no
// max_ram_speed_mt_s / m2_slots / sata_ports.
const b650RawSeed = () =>
  product('motherboards', 'MSI B650 Tomahawk WiFi', {
    socket: 'AM5',
    chipset: 'B650',
    form_factor: 'ATX',
    ram_type: 'DDR5',
    ram_slots: 4,
    max_ram_gb: 128,
  });

// Same board enriched with connector data (see ADR 0034).
const b650 = () =>
  product('motherboards', 'MSI B650 Tomahawk WiFi', {
    socket: 'AM5',
    chipset: 'B650',
    form_factor: 'ATX',
    ram_type: 'DDR5',
    ram_slots: 4,
    max_ram_gb: 128,
    max_ram_speed_mt_s: 6400,
    m2_slots: 3,
    sata_ports: 6,
  });

// MSI-PRO-B660M-A-WIFI-D4 (LGA1700, DDR4, 4 slots, 128GB), enriched.
const b660m = () =>
  product('motherboards', 'MSI PRO B660M-A WiFi DDR4', {
    socket: 'LGA1700',
    chipset: 'B660',
    form_factor: 'Micro-ATX',
    ram_type: 'DDR4',
    ram_slots: 4,
    max_ram_gb: 128,
    max_ram_speed_mt_s: 4800,
    m2_slots: 2,
    sata_ports: 4,
  });

// COR-VEN-D5-16-5600 (DDR5 16GB 2x8 5600) / KIN-FURY-D4-16-3200 (DDR4 2x8).
const ddr5Kit16 = (overrides: Record<string, unknown> = {}) =>
  product('ram', 'Corsair Vengeance DDR5 16GB', {
    ram_type: 'DDR5',
    ram_gb: 16,
    speed_mt_s: 5600,
    modules: 2,
    ...overrides,
  });
const ddr4Kit16 = (overrides: Record<string, unknown> = {}) =>
  product('ram', 'Kingston Fury Beast DDR4 16GB', {
    ram_type: 'DDR4',
    ram_gb: 16,
    speed_mt_s: 3200,
    modules: 2,
    ...overrides,
  });
const ddr5Kit32 = () =>
  product('ram', 'Corsair Vengeance RGB DDR5 32GB', {
    ram_type: 'DDR5',
    ram_gb: 32,
    speed_mt_s: 6000,
    modules: 2,
  });

// MSI-RTX4060-VENTUS-8G (115W) / MSI-RX7800XT-TRIO-16G (263W).
const rtx4060 = () => product('gpus', 'MSI RTX 4060 Ventus 2X 8GB', { tdp_w: 115 });
const rx7800xt = () => product('gpus', 'MSI RX 7800 XT Gaming Trio 16GB', { tdp_w: 263 });

// SAM-990PRO-1TB (NVMe M.2) / SAM-870EVO-1TB (SATA 2.5").
const nvme990 = () =>
  product('storage', 'Samsung 990 PRO 1TB NVMe', {
    storage_gb: 1024,
    storage_type: 'NVME',
    form_factor: 'M.2 2280',
  });
const sata870 = () =>
  product('storage', 'Samsung 870 EVO 1TB SATA', {
    storage_gb: 1024,
    storage_type: 'SSD',
    form_factor: '2.5 inch',
  });

// COR-CX550M-550W / SEA-FOCUS-GX650 / COR-RM750E-750W.
const psu550 = () => product('psus', 'Corsair CX550M 550W', { wattage_w: 550 });
const psu650 = () => product('psus', 'Seasonic Focus GX-650 650W', { wattage_w: 650 });

const laptop = () =>
  product('laptops', 'Lenovo IdeaPad Slim 5 16', { cpu: 'AMD Ryzen 7 7730U', ram_gb: 16 });

function ruleIssues(result: CompatibilityResult, rule: CompatibilityRule) {
  return result.issues.filter((issue) => issue.rule === rule);
}

describe('cpu-socket rule', () => {
  it('passes for a matching AM5 pair (Ryzen 5 7600 + B650 Tomahawk)', () => {
    const cpu = ryzen57600();
    const board = b650();
    const result = checkCompatibility([cpu, board, psu550()], 'en');
    expect(ruleIssues(result, 'cpu-socket')).toEqual([]);
  });

  it('fails for an AM5 CPU on an LGA1700 board (Ryzen 5 7600 + B660M)', () => {
    const cpu = ryzen57600();
    const board = b660m();
    const result = checkCompatibility([cpu, board], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'cpu-socket');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.productIds).toEqual([cpu.id, board.id]);
    expect(issues[0]?.messageKey).toBe('cpu-socket.mismatch');
  });

  it('fails for an LGA1700 CPU on an AM5 board (i5-13400F + B650)', () => {
    const result = checkCompatibility([i513400F(), b650()], 'es');
    const issues = ruleIssues(result, 'cpu-socket');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.message).toContain('LGA1700');
  });

  it('warns when the CPU has no socket spec', () => {
    const cpu = product('cpus', 'Mystery CPU', { tdp_w: 65 });
    const board = b650();
    const result = checkCompatibility([cpu, board], 'en');
    const issues = ruleIssues(result, 'cpu-socket');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.messageKey).toBe('cpu-socket.missing-data');
    // Missing data never claims compatibility.
    expect(result.compatible).toBe(false);
  });

  it('warns when the board has no socket spec', () => {
    const board = product('motherboards', 'Unknown board', { ram_type: 'DDR5' });
    const result = checkCompatibility([ryzen57600(), board], 'en');
    const issues = ruleIssues(result, 'cpu-socket');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });
});

describe('ram-type rule', () => {
  it('passes for DDR5 memory on a DDR5 board (Vengeance + B650)', () => {
    const result = checkCompatibility([b650(), ddr5Kit16()], 'en');
    expect(result.compatible).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('fails for DDR4 memory on a DDR5 board (Fury DDR4 + B650)', () => {
    const ram = ddr4Kit16();
    const board = b650();
    const result = checkCompatibility([board, ram], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'ram-type');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.messageKey).toBe('ram-type.mismatch');
    expect(issues[0]?.productIds).toEqual([ram.id, board.id]);
  });

  it('fails for DDR5 memory on a DDR4 board (Vengeance DDR5 + B660M)', () => {
    const result = checkCompatibility([b660m(), ddr5Kit16()], 'en');
    expect(ruleIssues(result, 'ram-type')).toHaveLength(1);
    expect(ruleIssues(result, 'ram-type')[0]?.severity).toBe('error');
    expect(result.compatible).toBe(false);
  });

  it('warns when the memory kit has no ram_type', () => {
    const ram = product('ram', 'Generic 16GB', { ram_gb: 16 });
    const result = checkCompatibility([b650(), ram], 'en');
    const issues = ruleIssues(result, 'ram-type');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });

  it('warns when the board has no ram_type', () => {
    const board = product('motherboards', 'Bare board', { socket: 'AM5' });
    const result = checkCompatibility([board, ddr5Kit16()], 'en');
    expect(ruleIssues(result, 'ram-type')[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });
});

describe('ram-capacity rule', () => {
  it('passes for 32GB on a 128GB board', () => {
    const result = checkCompatibility([b650(), ddr5Kit16(), ddr5Kit16()], 'en');
    expect(ruleIssues(result, 'ram-capacity')).toEqual([]);
  });

  it('passes exactly at the board maximum (4x32GB = 128GB)', () => {
    const kit = () =>
      product('ram', 'DDR5 32GB single', {
        ram_type: 'DDR5',
        ram_gb: 32,
        speed_mt_s: 5600,
        modules: 1,
      });
    const result = checkCompatibility([b650(), kit(), kit(), kit(), kit()], 'en');
    expect(ruleIssues(result, 'ram-capacity')).toEqual([]);
  });

  it('fails when total memory exceeds the maximum (5x32GB = 160GB > 128GB)', () => {
    const kit = () =>
      product('ram', 'DDR5 32GB single', {
        ram_type: 'DDR5',
        ram_gb: 32,
        speed_mt_s: 5600,
        modules: 1,
      });
    const board = b650();
    const kits = [kit(), kit(), kit(), kit(), kit()];
    const result = checkCompatibility([board, ...kits], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'ram-capacity');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.messageKey).toBe('ram-capacity.exceeded');
  });

  it('warns when the board has no max_ram_gb (raw seed board shape)', () => {
    const board = product('motherboards', 'Board without max', {
      socket: 'AM5',
      ram_type: 'DDR5',
      ram_slots: 4,
    });
    const result = checkCompatibility([board, ddr5Kit16()], 'en');
    expect(ruleIssues(result, 'ram-capacity')[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });

  it('warns when a kit has no ram_gb', () => {
    const ram = product('ram', 'Kit without capacity', { ram_type: 'DDR5', modules: 2 });
    const result = checkCompatibility([b650(), ram], 'en');
    expect(ruleIssues(result, 'ram-capacity')[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });
});

describe('ram-slots rule', () => {
  it('passes when modules fit exactly (2 kits x2 = 4 slots)', () => {
    const result = checkCompatibility([b650(), ddr5Kit16(), ddr5Kit16()], 'en');
    expect(ruleIssues(result, 'ram-slots')).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it('fails when modules exceed slots (3 kits x2 = 6 > 4)', () => {
    const board = b650();
    const result = checkCompatibility([board, ddr5Kit16(), ddr5Kit16(), ddr5Kit16()], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'ram-slots');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.messageKey).toBe('ram-slots.exceeded');
  });

  it('counts a kit without modules as a single stick', () => {
    const single = product('ram', 'Single DDR5 16GB', {
      ram_type: 'DDR5',
      ram_gb: 16,
      speed_mt_s: 5600,
    });
    const result = checkCompatibility([b650(), single], 'en');
    expect(ruleIssues(result, 'ram-slots')).toEqual([]);
  });

  it('warns when the board has no ram_slots', () => {
    const board = product('motherboards', 'Board without slots', {
      socket: 'AM5',
      ram_type: 'DDR5',
      max_ram_gb: 128,
    });
    const result = checkCompatibility([board, ddr5Kit16()], 'en');
    expect(ruleIssues(result, 'ram-slots')[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });
});

describe('ram-speed rule', () => {
  it('passes when the kit is within the board maximum (5600 <= 6400)', () => {
    const result = checkCompatibility([b650(), ddr5Kit16()], 'en');
    expect(ruleIssues(result, 'ram-speed')).toEqual([]);
  });

  it('warns (not errors) when the kit exceeds the board maximum', () => {
    const board = b650();
    const ram = ddr5Kit32(); // 6000 MT/s
    const slowBoard = product('motherboards', 'MSI B650 Tomahawk WiFi', {
      ...board.specs,
      max_ram_speed_mt_s: 5200,
    });
    const result = checkCompatibility([slowBoard, ram], 'en');
    const issues = ruleIssues(result, 'ram-speed');
    expect(issues).toHaveLength(1);
    // Faster memory downclocks and still works: warning, never error.
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.messageKey).toBe('ram-speed.exceeded');
    expect(result.compatible).toBe(false);
  });

  it('warns when the board has no max_ram_speed_mt_s (raw seed board)', () => {
    const result = checkCompatibility([b650RawSeed(), ddr5Kit16()], 'en');
    const issues = ruleIssues(result, 'ram-speed');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.messageKey).toBe('ram-speed.missing-data');
    expect(result.compatible).toBe(false);
  });

  it('warns when the kit has no speed_mt_s', () => {
    const ram = product('ram', 'Kit without speed', { ram_type: 'DDR5', ram_gb: 16, modules: 2 });
    const result = checkCompatibility([b650(), ram], 'en');
    expect(ruleIssues(result, 'ram-speed')[0]?.messageKey).toBe('ram-speed.missing-data');
    expect(result.compatible).toBe(false);
  });
});

describe('storage-interface rule', () => {
  it('passes for an NVMe drive on a board with free M.2 slots (990 PRO + B650)', () => {
    const result = checkCompatibility([b650(), nvme990()], 'en');
    expect(result.compatible).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('passes for a SATA drive on a board with free SATA ports (870 EVO + B650)', () => {
    const result = checkCompatibility([b650(), sata870()], 'en');
    expect(ruleIssues(result, 'storage-interface')).toEqual([]);
  });

  it('fails when NVMe drives exceed M.2 slots (2 drives, 1 slot)', () => {
    const board = product('motherboards', 'Tiny board', {
      socket: 'AM5',
      m2_slots: 1,
      sata_ports: 4,
    });
    const first = nvme990();
    const second = nvme990();
    const result = checkCompatibility([board, first, second], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'storage-interface');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.productIds).toEqual([second.id, board.id]);
    expect(issues[0]?.messageKey).toBe('storage-interface.unsupported');
  });

  it('fails when a SATA drive has no free SATA port', () => {
    const board = product('motherboards', 'Board without SATA', {
      socket: 'AM5',
      m2_slots: 2,
      sata_ports: 0,
    });
    const result = checkCompatibility([board, sata870()], 'en');
    const issues = ruleIssues(result, 'storage-interface');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(result.compatible).toBe(false);
  });

  it('warns when the board has no connector data (raw seed board + 990 PRO)', () => {
    const result = checkCompatibility([b650RawSeed(), nvme990()], 'en');
    const issues = ruleIssues(result, 'storage-interface');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.messageKey).toBe('storage-interface.missing-data');
    expect(result.compatible).toBe(false);
  });

  it('warns for a drive without interface data', () => {
    const drive = product('storage', 'Mystery drive', { storage_gb: 512 });
    const result = checkCompatibility([b650(), drive], 'en');
    expect(ruleIssues(result, 'storage-interface')[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });
});

describe('psu-wattage rule', () => {
  it('passes for Ryzen 5 7600 + RTX 4060 on a 550W supply (est. 280W, need 336W)', () => {
    const result = checkCompatibility([ryzen57600(), rtx4060(), b650(), psu550()], 'en');
    expect(ruleIssues(result, 'psu-wattage')).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it('fails for i7-14700K + RX 7800 XT on a 550W supply (est. 488W, need 586W)', () => {
    const cpu = i714700K();
    const gpu = rx7800xt();
    const psu = psu550();
    const result = checkCompatibility([cpu, gpu, b660m(), psu], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'psu-wattage');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.messageKey).toBe('psu-wattage.insufficient');
    expect(issues[0]?.productIds).toContain(psu.id);
  });

  it('passes the same heavy build on a 650W supply (need 586W)', () => {
    const result = checkCompatibility([i714700K(), rx7800xt(), b660m(), psu650()], 'en');
    expect(ruleIssues(result, 'psu-wattage')).toEqual([]);
  });

  it('warns when a component TDP is missing', () => {
    const gpu = product('gpus', 'GPU without TDP', { vram_gb: 8 });
    const result = checkCompatibility([ryzen57600(), gpu, psu550()], 'en');
    const issues = ruleIssues(result, 'psu-wattage');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.messageKey).toBe('psu-wattage.missing-data');
    expect(result.compatible).toBe(false);
  });

  it('warns when the supply has no wattage_w', () => {
    const psu = product('psus', 'PSU without wattage', { efficiency: '80+ Gold' });
    const result = checkCompatibility([ryzen57600(), rtx4060(), psu], 'en');
    expect(ruleIssues(result, 'psu-wattage')[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });

  it('warns when CPU/GPU are present but no PSU was included', () => {
    const result = checkCompatibility([ryzen57600(), rtx4060(), b650()], 'en');
    expect(ruleIssues(result, 'psu-wattage')).toEqual([]);
    const issues = ruleIssues(result, 'build-needs-psu');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(result.compatible).toBe(false);
  });
});

describe('build-shape rules', () => {
  it('fails with two motherboards in one build', () => {
    const result = checkCompatibility([b650(), b660m(), ryzen57600()], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'build-single-board');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
  });

  it('fails with two CPUs in one build', () => {
    const result = checkCompatibility([ryzen57600(), i513400F(), b650()], 'en');
    expect(result.compatible).toBe(false);
    const issues = ruleIssues(result, 'build-single-cpu');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
  });

  it('warns when loose components have no board (lone Ryzen 5 7600)', () => {
    const cpu = ryzen57600();
    const result = checkCompatibility([cpu], 'en');
    const issues = ruleIssues(result, 'build-needs-board');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.productIds).toEqual([cpu.id]);
    expect(result.compatible).toBe(false);
  });

  it('does not warn about a missing board when a board is present', () => {
    const result = checkCompatibility([ryzen57600(), b650(), psu550()], 'en');
    expect(ruleIssues(result, 'build-needs-board')).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it('warns when a laptop is mixed with loose components', () => {
    const laptopProduct = laptop();
    const cpu = ryzen57600();
    const result = checkCompatibility([laptopProduct, cpu], 'es');
    const issues = ruleIssues(result, 'build-laptop-mix');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.productIds).toContain(laptopProduct.id);
    expect(issues[0]?.productIds).toContain(cpu.id);
    expect(result.compatible).toBe(false);
  });

  it('passes for a lone laptop (closed system, nothing to combine)', () => {
    const result = checkCompatibility([laptop()], 'en');
    expect(result.compatible).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('passes for two laptops (buying two systems is fine)', () => {
    const result = checkCompatibility([laptop(), laptop()], 'en');
    expect(result.compatible).toBe(true);
  });
});

describe('full-build integration', () => {
  it('marks a coherent AM5 build compatible (7600 + B650 + DDR5 + 990 PRO + 4060 + 550W)', () => {
    const result = checkCompatibility(
      [ryzen57600(), b650(), ddr5Kit16(), nvme990(), rtx4060(), psu550()],
      'en',
    );
    expect(result.issues).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it('collects several errors for a fully mismatched build', () => {
    // AM5 CPU + LGA1700/DDR4 board + DDR5 RAM + power-hungry GPU on 550W:
    // socket, RAM type and PSU all fail. The CPU mirrors the seed 7800X3D
    // (AM5, 120W): 100 + 120 + 263 = 483W estimated, 580W required > 550W.
    const cpu = product('cpus', 'AMD Ryzen 7 7800X3D', { socket: 'AM5', tdp_w: 120 });
    const result = checkCompatibility([cpu, b660m(), ddr5Kit16(), rx7800xt(), psu550()], 'en');
    expect(result.compatible).toBe(false);
    expect(ruleIssues(result, 'cpu-socket')[0]?.severity).toBe('error');
    expect(ruleIssues(result, 'ram-type')[0]?.severity).toBe('error');
    expect(ruleIssues(result, 'psu-wattage')[0]?.severity).toBe('error');
  });
});

describe('helpers and i18n', () => {
  it('classifies NVME as M.2 and SSD/HDD as SATA', () => {
    expect(classifyStorageNeed({ storage_type: 'NVME' })).toBe('M.2');
    expect(classifyStorageNeed({ storage_type: 'SSD' })).toBe('SATA');
    expect(classifyStorageNeed({ storage_type: 'HDD' })).toBe('SATA');
    expect(classifyStorageNeed({ form_factor: 'M.2 2280' })).toBe('M.2');
    expect(classifyStorageNeed({ form_factor: '2.5 inch' })).toBe('SATA');
    expect(classifyStorageNeed({})).toBeNull();
    expect(classifyStorageNeed({ storage_type: 'TAPE' })).toBeNull();
  });

  it('estimates draw as 100W base plus CPU and GPU TDPs', () => {
    expect(estimateDrawW([ryzen57600()], [rtx4060()])).toBe(100 + 65 + 115);
    expect(estimateDrawW([], [])).toBe(100);
    const noTdp = product('gpus', 'GPU without TDP', {});
    expect(estimateDrawW([ryzen57600()], [noTdp])).toBeNull();
  });

  it('requires estimated draw plus 20% headroom, rounded up', () => {
    expect(requiredPsuW(280)).toBe(336);
    expect(requiredPsuW(488)).toBe(586);
    expect(requiredPsuW(100)).toBe(120);
  });

  it('renders messages in Spanish and English under the same key', () => {
    const cpu = ryzen57600();
    const board = b660m();
    const es = checkCompatibility([cpu, board], 'es');
    const en = checkCompatibility([cpu, board], 'en');
    const esIssues = ruleIssues(es, 'cpu-socket');
    const enIssues = ruleIssues(en, 'cpu-socket');
    expect(esIssues).toHaveLength(1);
    expect(enIssues).toHaveLength(1);
    const esMessage = esIssues.map((issue) => issue.message).join(' ');
    const enMessage = enIssues.map((issue) => issue.message).join(' ');
    expect(esIssues[0]?.messageKey).toBe(enIssues[0]?.messageKey);
    expect(esMessage).not.toBe(enMessage);
    expect(esMessage).toContain('No encajan');
    expect(enMessage).toContain('do not fit');
  });

  it('falls back to English for unsupported locales', () => {
    expect(resolveCompatibilityLocale('fr')).toBe('en');
    expect(resolveCompatibilityLocale(undefined)).toBe('en');
    expect(resolveCompatibilityLocale('es')).toBe('es');
    expect(resolveCompatibilityLocale('es-MX')).toBe('es');
  });
});
