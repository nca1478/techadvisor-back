# 0064 — Búsqueda con filtros exclusivos (`q` opcional)

Fecha: 2026-10-18
Estado: aceptado

## Contexto

La página `/buscar` solo buscaba con `q` obligatorio: entrar directo,
poner categoría/precio y pulsar Aplicar no hacía nada (el servidor ni
buscaba y la vista mostraba el vacío). Los tres campos deben ser
exclusivos: cualquiera puede ir vacío y se filtra por los demás.

## Decisión

- `GET /api/v1/search`: `q` pasa a opcional (máx. 200, por defecto `''`).
- Con `q` vacía no hay retrieval ni embeddings: se listan productos
  `ACTIVE` desde SQL (filtro de categoría en la consulta, precio máximo
  sobre el precio resuelto por moneda como en la rama con `q`), orden
  determinista por nombre, `score: 0` y snippet desde la descripción SQL.
- Sin ningún filtro la página sigue mostrando la pista inicial (no se
  llama al backend).

## Consecuencias

- Explorar por categoría/precio no cuesta embeddings y nunca falla por el
  proveedor (`degraded: false`).
- El contrato cambia de forma compatible: `q` deja de ser requerido.
