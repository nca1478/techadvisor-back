/**
 * i18n message catalog for the compatibility engine (`es` + `en`).
 *
 * Plain templates with `{placeholders}` — no provider-specific features, no
 * LLM involved. Messages are intentionally jargon-free: they name the
 * products and the values that clash so any customer can understand them.
 */

import type { CompatibilityMessageKey } from './compatibility.types.js';

export type CompatibilityLocale = 'es' | 'en';

const MESSAGES: Record<CompatibilityMessageKey, Record<CompatibilityLocale, string>> = {
  'cpu-socket.mismatch': {
    es: 'El procesador "{cpu}" usa socket {cpuSocket}, pero la placa "{board}" usa socket {boardSocket}. No encajan entre sí.',
    en: 'Processor "{cpu}" uses socket {cpuSocket}, but board "{board}" uses socket {boardSocket}. They do not fit together.',
  },
  'cpu-socket.missing-data': {
    es: 'No se pudo comprobar el socket entre "{cpu}" y "{board}" porque falta el dato de socket en uno de los dos.',
    en: 'Could not check the socket between "{cpu}" and "{board}" because the socket is missing on one of them.',
  },
  'ram-type.mismatch': {
    es: 'La memoria "{ram}" es {ramType}, pero la placa "{board}" solo acepta {boardType}. No son compatibles.',
    en: 'Memory "{ram}" is {ramType}, but board "{board}" only accepts {boardType}. They are not compatible.',
  },
  'ram-type.missing-data': {
    es: 'No se pudo comprobar el tipo de memoria entre "{ram}" y "{board}" porque falta el dato en uno de los dos.',
    en: 'Could not check the memory type between "{ram}" and "{board}" because the data is missing on one of them.',
  },
  'ram-capacity.exceeded': {
    es: 'La memoria total ({totalGb} GB) supera el máximo de la placa "{board}" ({maxGb} GB). Quita algún módulo o elige una placa con más capacidad.',
    en: 'Total memory ({totalGb} GB) exceeds the maximum of board "{board}" ({maxGb} GB). Remove a module or choose a board with more capacity.',
  },
  'ram-capacity.missing-data': {
    es: 'No se pudo comprobar la capacidad máxima de memoria de "{board}" porque faltan datos de capacidad.',
    en: 'Could not check the maximum memory capacity of "{board}" because capacity data is missing.',
  },
  'ram-slots.exceeded': {
    es: 'Necesitas {needSlots} ranuras de memoria, pero la placa "{board}" solo tiene {slots} ranuras.',
    en: 'You need {needSlots} memory slots, but board "{board}" only has {slots} slots.',
  },
  'ram-slots.missing-data': {
    es: 'No se pudo comprobar las ranuras de memoria de "{board}" porque faltan datos de módulos o ranuras.',
    en: 'Could not check the memory slots of "{board}" because module or slot data is missing.',
  },
  'ram-speed.exceeded': {
    es: 'La memoria "{ram}" funciona a {speed} MT/s, por encima del máximo de la placa "{board}" ({maxSpeed} MT/s). Funcionará, pero a velocidad reducida.',
    en: 'Memory "{ram}" runs at {speed} MT/s, above the maximum of board "{board}" ({maxSpeed} MT/s). It will work, but at reduced speed.',
  },
  'ram-speed.missing-data': {
    es: 'No se pudo comprobar la velocidad de la memoria "{ram}" con la placa "{board}" porque falta el dato de velocidad.',
    en: 'Could not check the speed of memory "{ram}" against board "{board}" because speed data is missing.',
  },
  'storage-interface.unsupported': {
    es: 'La unidad "{drive}" necesita conexión {need}, pero la placa "{board}" no tiene suficientes conectores libres de ese tipo.',
    en: 'Drive "{drive}" needs a {need} connection, but board "{board}" has no free connectors of that type left.',
  },
  'storage-interface.missing-data': {
    es: 'No se pudo comprobar la conexión de "{drive}" con la placa "{board}" porque faltan datos de conectores o de la unidad.',
    en: 'Could not check the connection of "{drive}" against board "{board}" because connector or drive data is missing.',
  },
  'psu-wattage.insufficient': {
    es: 'La fuente "{psu}" ({wattage} W) es insuficiente: el equipo necesita unos {required} W (consumo estimado de {estimated} W más un margen del 20 %). Elige una fuente de al menos {required} W.',
    en: 'Power supply "{psu}" ({wattage} W) is insufficient: this build needs about {required} W (estimated draw of {estimated} W plus a 20% margin). Choose a supply of at least {required} W.',
  },
  'psu-wattage.missing-data': {
    es: 'No se pudo comprobar la potencia porque falta el consumo (TDP) de algún componente o la potencia de la fuente.',
    en: 'Could not check the power requirements because the power draw (TDP) of a component or the supply wattage is missing.',
  },
  'build-single-board.multiple': {
    es: 'Hay más de una placa base en la combinación ({names}). Un equipo lleva una sola placa base.',
    en: 'There is more than one motherboard in this build ({names}). A build uses a single motherboard.',
  },
  'build-single-cpu.multiple': {
    es: 'Hay más de un procesador en la combinación ({names}). Un equipo de consumo lleva un solo procesador.',
    en: 'There is more than one processor in this build ({names}). A consumer build uses a single processor.',
  },
  'build-needs-board.missing': {
    es: 'La combinación incluye componentes sueltos pero ninguna placa base, así que no se pudo comprobar la compatibilidad de socket, memoria o almacenamiento.',
    en: 'This build includes loose components but no motherboard, so socket, memory and storage compatibility could not be checked.',
  },
  'build-needs-psu.missing': {
    es: 'La combinación incluye procesador o tarjeta gráfica pero ninguna fuente de poder, así que no se pudo comprobar si la potencia es suficiente.',
    en: 'This build includes a processor or graphics card but no power supply, so power sufficiency could not be checked.',
  },
  'build-laptop-mix.mixed': {
    es: '"{laptop}" es un equipo cerrado y no se combina con componentes sueltos ({names}).',
    en: '"{laptop}" is a closed system and cannot be combined with loose components ({names}).',
  },
};

/** Resolves the supported locale, defaulting to `en` for anything else. */
export function resolveCompatibilityLocale(locale: string | undefined): CompatibilityLocale {
  const normalized = (locale ?? '').trim().toLowerCase();
  if (normalized === 'es' || normalized.startsWith('es-')) {
    return 'es';
  }
  return 'en';
}

function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

/** Renders a catalog message in the requested locale with params applied. */
export function renderCompatibilityMessage(
  key: CompatibilityMessageKey,
  locale: CompatibilityLocale,
  params: Record<string, string | number> = {},
): string {
  return format(MESSAGES[key][locale], params);
}
