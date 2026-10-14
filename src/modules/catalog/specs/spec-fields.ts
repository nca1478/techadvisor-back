/**
 * Structured `specs` field definitions per category.
 *
 * Keys are always `snake_case` and typed. These definitions are the single
 * source of truth for structured attributes: the backend validates `specs`
 * JSONB against them (writes, P1.7) and exposes them via
 * `GET /catalog/categories/:slug` (`specsSchema`) so the frontend builds
 * forms and comparison tables without duplicating the schema.
 */

export type SpecFieldType = 'string' | 'integer' | 'number' | 'boolean' | 'enum';

export interface SpecFieldDef {
  /** snake_case attribute key stored in `products.specs`. */
  key: string;
  /** Human-readable label (English; UI localization happens client-side). */
  label: string;
  type: SpecFieldType;
  /** Unit symbol for numeric fields (e.g. "GB", "inches", "W"). */
  unit?: string;
  /** Allowed values for `enum` fields. */
  options?: string[];
}

const LAPTOP_FIELDS: SpecFieldDef[] = [
  { key: 'cpu', label: 'Processor', type: 'string' },
  { key: 'ram_gb', label: 'RAM', type: 'integer', unit: 'GB' },
  { key: 'storage_gb', label: 'Storage', type: 'integer', unit: 'GB' },
  {
    key: 'storage_type',
    label: 'Storage type',
    type: 'enum',
    options: ['SSD', 'HDD', 'NVME'],
  },
  { key: 'screen_inches', label: 'Screen size', type: 'number', unit: 'inches' },
  { key: 'gpu', label: 'Graphics', type: 'string' },
  { key: 'weight_kg', label: 'Weight', type: 'number', unit: 'kg' },
  { key: 'battery_wh', label: 'Battery', type: 'integer', unit: 'Wh' },
];

const CPU_FIELDS: SpecFieldDef[] = [
  { key: 'socket', label: 'Socket', type: 'string' },
  { key: 'cores', label: 'Cores', type: 'integer' },
  { key: 'threads', label: 'Threads', type: 'integer' },
  { key: 'base_ghz', label: 'Base clock', type: 'number', unit: 'GHz' },
  { key: 'boost_ghz', label: 'Boost clock', type: 'number', unit: 'GHz' },
  { key: 'tdp_w', label: 'TDP', type: 'integer', unit: 'W' },
];

const MOTHERBOARD_FIELDS: SpecFieldDef[] = [
  { key: 'socket', label: 'Socket', type: 'string' },
  { key: 'chipset', label: 'Chipset', type: 'string' },
  { key: 'form_factor', label: 'Form factor', type: 'string' },
  {
    key: 'ram_type',
    label: 'Memory type',
    type: 'enum',
    options: ['DDR4', 'DDR5'],
  },
  { key: 'ram_slots', label: 'Memory slots', type: 'integer' },
  { key: 'max_ram_gb', label: 'Max memory', type: 'integer', unit: 'GB' },
  { key: 'max_ram_speed_mt_s', label: 'Max memory speed', type: 'integer', unit: 'MT/s' },
  { key: 'm2_slots', label: 'M.2 slots', type: 'integer' },
  { key: 'sata_ports', label: 'SATA ports', type: 'integer' },
];

const RAM_FIELDS: SpecFieldDef[] = [
  {
    key: 'ram_type',
    label: 'Memory type',
    type: 'enum',
    options: ['DDR4', 'DDR5'],
  },
  { key: 'ram_gb', label: 'Capacity', type: 'integer', unit: 'GB' },
  { key: 'speed_mt_s', label: 'Speed', type: 'integer', unit: 'MT/s' },
  { key: 'modules', label: 'Modules', type: 'integer' },
];

const GPU_FIELDS: SpecFieldDef[] = [
  { key: 'chipset', label: 'Chipset', type: 'string' },
  { key: 'vram_gb', label: 'VRAM', type: 'integer', unit: 'GB' },
  { key: 'boost_mhz', label: 'Boost clock', type: 'integer', unit: 'MHz' },
  { key: 'tdp_w', label: 'TDP', type: 'integer', unit: 'W' },
  { key: 'length_mm', label: 'Length', type: 'integer', unit: 'mm' },
];

const STORAGE_FIELDS: SpecFieldDef[] = [
  { key: 'storage_gb', label: 'Capacity', type: 'integer', unit: 'GB' },
  {
    key: 'storage_type',
    label: 'Type',
    type: 'enum',
    options: ['SSD', 'HDD', 'NVME'],
  },
  {
    key: 'form_factor',
    label: 'Form factor',
    type: 'string',
  },
  { key: 'read_mb_s', label: 'Sequential read', type: 'integer', unit: 'MB/s' },
  { key: 'write_mb_s', label: 'Sequential write', type: 'integer', unit: 'MB/s' },
];

const PSU_FIELDS: SpecFieldDef[] = [
  { key: 'wattage_w', label: 'Wattage', type: 'integer', unit: 'W' },
  {
    key: 'efficiency',
    label: 'Efficiency rating',
    type: 'enum',
    options: ['80+ Bronze', '80+ Silver', '80+ Gold', '80+ Platinum', '80+ Titanium'],
  },
  {
    key: 'modular',
    label: 'Modular',
    type: 'enum',
    options: ['non-modular', 'semi-modular', 'full-modular'],
  },
];

const MONITOR_FIELDS: SpecFieldDef[] = [
  { key: 'screen_inches', label: 'Screen size', type: 'number', unit: 'inches' },
  { key: 'resolution', label: 'Resolution', type: 'string' },
  { key: 'panel_type', label: 'Panel type', type: 'string' },
  { key: 'refresh_hz', label: 'Refresh rate', type: 'integer', unit: 'Hz' },
];

/**
 * Field tables keyed by category slug. Slugs not listed here expose an
 * empty `specsSchema` (unstructured `specs` still returned as-is).
 */
export const SPECS_FIELDS_BY_CATEGORY: Readonly<Record<string, readonly SpecFieldDef[]>> = {
  laptops: LAPTOP_FIELDS,
  cpus: CPU_FIELDS,
  motherboards: MOTHERBOARD_FIELDS,
  ram: RAM_FIELDS,
  gpus: GPU_FIELDS,
  storage: STORAGE_FIELDS,
  psus: PSU_FIELDS,
  monitors: MONITOR_FIELDS,
};

/** Field definitions for a category slug, or an empty array when unknown. */
export function getSpecsFields(categorySlug: string): readonly SpecFieldDef[] {
  return SPECS_FIELDS_BY_CATEGORY[categorySlug] ?? [];
}
