# 0061 — Normalización de alias de socket en el motor de compatibilidad

- Estado: aceptado
- Fecha: 2026-10-17
- Repo afectado: `backend`

## Contexto

El carrito marcó como incompatibles un `Intel Core Ultra 5 235 (LGA1851)`
y una `ASUS ROG Maximus Z890 Hero (socket 1851)` aunque ambos son LGA1851.
La regla `cpu-socket` comparaba strings exactos (`trim + UPPER`),
así que `LGA1851 !== 1851` generaba un error falso.

El mismo socket aparece en datos reales como `1851`, `LGA1851`,
`FCLGA1851`, `LGA 1851`, `Socket LGA1851`, `FCLGA-1851` (incluido guion
unicode `‑` de las fichas Intel).

## Decisión

Añadir `normalizeSocket()` en `modules/compatibility/rules/rules.ts`
y usarlo solo en `checkCpuSocket`:

1. Mayúsculas, sin tildes, sin separadores (`[^A-Z0-9]`).
2. Quitar la palabra genérica `SOCKET` / `ZOCALO`.
3. Quitar prefijo de encapsulado Intel `FCLGA` / `LGA` (y `PGA` / `BGA`).
4. Comparar la clave resultante (`LGA1851 → 1851`, `Socket AM5 → AM5`).

Si la clave normalizada queda vacía se emite `cpu-socket.missing-data`
(warning), nunca un pass silencioso. El mensaje conserva los valores
originales para depuración. `ram-type` y el resto de reglas no cambian.

## Consecuencias

- `LGA1851` hace match con `1851`, `FCLGA1851`, `LGA 1851`,
  `Socket LGA1851`, etc. Lo mismo para `LGA1700` y familias AMD
  (`Socket AM5 → AM5`).
- Sockets distintos siguen fallando (`1851` vs `1700`, `AM5` vs `AM4`).
- Sin migración de BD, sin dependencias nuevas. Tests en `rules.spec.ts`.
