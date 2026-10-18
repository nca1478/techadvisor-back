# 0063 — Compatibility check quantity-aware (`items` with qty)

- Estado: aceptado
- Fecha: 2026-10-18
- Contexto: `POST /compatibility/check` aceptaba solo `productIds` únicos (set 1..20). El motor evaluaba una unidad por producto, así que el carrito nunca advertía al subir `qty`: 3x SATA en placa de 2 puertos, 3x RAM en placa de 2 slots/32GB, 2x M.2 en 1 slot o 2x misma placa/CPU pasaban como compatibles.
- Decisión: añadir `items: [{ productId, qty 1..999 }]` opcional (misma cota que `MAX_QTY_PER_LINE`), manteniendo `productIds` legacy (equivale a qty 1). Si un id aparece en ambas listas, gana `items`. El servicio construye `qtyById`, hidrata los distintos y expande la lista por qty antes de `checkCompatibility` (reutiliza las reglas existentes sin cambiarlas). `productIds` de cada issue se dedupean para display estable.
- Alternativas: pasar `qty` al motor y reescribir cada regla (más invasivo); rechazar `productIds` (rompe compatibilidad con clientes/e2e existentes).
- Consecuencias: sin migración (solo DTO+esquema Zod). `compatible` sigue siendo true solo con cero issues. Límite: 20 productos distintos; expansión máxima 20*999 unidades, aceptable para reglas O(n).
