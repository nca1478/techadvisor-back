# 0078 — Recuperación de contraseña local por OTP + Resend

- Fecha: 2026-10-20
- Estado: aceptado

## Contexto

La tienda solo tenía login local/Google sin recuperación. El flujo pedido
tiene 3 pantallas (email → OTP de 6 dígitos → nueva contraseña) con correos
vía Resend, TTL del OTP de 10 minutos y aviso de cambio exitoso.

## Decisión

- Nuevo `MailModule` global con interfaz `MailProvider`; adapters `fake`
  (dev/test) y `resend` (único import del SDK). Selección por `MAIL_PROVIDER`.
- Nueva tabla aditiva `password_resets` (hashes SHA-256 del OTP y del
  `resetToken`, intentos, expiración, consumo). Endpoints públicos bajo el
  throttler existente: `POST /auth/password/request|verify|reset`.
## Decisión inicial

- Nuevo `MailModule` global con interfaz `MailProvider`; adapters `fake`
  (dev/test) y `resend` (único import del SDK). Selección por `MAIL_PROVIDER`.
- Nueva tabla aditiva `password_resets` (hashes SHA-256 del OTP y del
  `resetToken`, intentos, expiración, consumo). Endpoints públicos bajo el
  throttler existente: `POST /auth/password/request|verify|reset`.
- `request` respondía siempre `{ok:true}` (anti-enumeración); solo usuarios
  `LOCAL` con password recibían correo. `verify` emite `resetToken` opaco de
  un solo uso (15 min). `confirm` re-hashea con argon2 y envía correo de
  confirmación.

## Cambio 2026-10-21 — `request` responde 404 si el email no existe

- Decisión de producto: la pantalla de solicitud debe informar "este correo
  no está registrado" cuando no hay cuenta con ese email, y "no se puede
  cambiar la contraseña" (409, sin mencionar jamás Google/Gmail) cuando la
  cuenta existe pero no tiene contraseña local (cuentas Google).
- Se acepta el trade-off: este endpoint permite enumerar emails registrados.
  El login (`401 Invalid credentials`) sigue sin filtrar existencia.

## Purga 2026-10-21 — `cleanupExpired` + purga oportunista

- Sin scheduler ni dependencias nuevas: `request()` borra los desafíos
  muertos del usuario (consumidos o inutilizables) antes de emitir un código
  nuevo, y `POST /auth/password/cleanup` (solo ADMIN) purga toda la tabla
  con el mismo criterio. Los desafíos verificados con `resetToken` vigente
  sobreviven.
- Versión instalada: `resend@6.34.1` (verificado con `npm view resend version`;
  MCP context7 sin resultados en este entorno, se usó el fallback permitido).

## Alternativas descartadas

- Link mágico con JWT en la URL: expone tokens en logs/historial; el OTP de
  6 dígitos coincide con las pantallas aprobadas.
- Verificar + cambiar en una sola llamada: impediría las 3 pantallas separadas.

## Consecuencias

- Nuevas envs `MAIL_*` + `PASSWORD_RESET_*` (ver `.env.example`); `MAIL_PROVIDER=resend`
  exige `RESEND_API_KEY` + `MAIL_FROM` (dominio verificado) o el boot falla.
- Sin cambios destructivos; el frontend proxya por BFF sin guardar secretos.
