# 0077 — Login con Google (GIS ID token)

- **Estado:** aceptado.
- **Fecha:** 2026-10-19.

## Contexto

Se pide botón "Continuar con Google" bajo "Iniciar sesión": si el email verificado
no existe se crea usuario CUSTOMER sin contraseña (`name`, `email`, `provider=google`);
si existe (local o google) inicia sesión. Hay que agregar `provider` a `users`
y no romper el login local ni las reglas (migraciones aditivas, sin SDKs de IA
fuera de adapters, sin commits automáticos).

## Decisión

- Flujo **Google Identity Services (frontend) → `POST /api/v1/auth/google`
  con `{ idToken }` → verificación en backend** con `google-auth-library@11.3.1`
  (versión vigente verificada vía Context7 + `npm view`, docs oficiales
  `OAuth2Client.verifyIdToken({ idToken, audience })`).
  Se descarta el flujo redirect con `passport-google-oauth20`: más piezas
  (callback, sesiones) para el mismo resultado.
- Nuevo `GoogleIdTokenVerifier` (`src/modules/auth/google-id-token.verifier.ts`):
  único archivo autorizado a importar `google-auth-library`; valida firma,
  `aud=GOOGLE_CLIENT_ID`, `iss/exp` y `email_verified`; errores → `401` genérico;
  sin `GOOGLE_CLIENT_ID` → `401` (endpoint deshabilitado, login local intacto).
  Nunca se loguea el token.
- BD solo aditiva (`20261020000000_add_auth_provider_google`):
  `enum AuthProvider { LOCAL, GOOGLE }`, `users.provider DEFAULT 'LOCAL'`,
  `password_hash` pasa a nullable (expansión compatible) para usuarios Google
  sin contraseña. `register` fija `LOCAL`; `createGoogleUser` fija
  `GOOGLE/CUSTOMER/passwordHash NULL`. El login local rechaza `passwordHash NULL`
  con el mismo `401 Invalid credentials` (sin enumeración).
- `loginWithGoogle` no reescribe `provider` de usuarios existentes.
- Env: `GOOGLE_CLIENT_ID` (backend, opcional) + `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
  (frontend, mismo valor, pública por diseño GIS). El usuario las asigna
  manualmente desde Google Cloud Console (orígenes JS autorizados).
- Frontend sin dependencia npm nueva: `<Script accounts.google.com/gsi/client>`.

## Consecuencias

- Contrato OpenAPI: `UserResponseDto.provider`, `POST /auth/google`.
  El frontend regenera tipos con `npm run api:types`.
- Tests unitarios + e2e del nuevo endpoint; seeder fija `provider LOCAL`.
- Futuro (no alcance): guardar `googleSub` para hardening si cambia el email.

## Nota 2026-10-19 — flujo popup para móvil

El botón propio usa OAuth2 por popup (`access_token`) en vez del prompt One
Tap, que en móvil no se muestra de forma fiable (suprimido/recortado).
`POST /auth/google` acepta `{ idToken }` o `{ accessToken }`; el segundo se
resuelve server-side contra userinfo (sin client secret) y solo admite emails
verificados. Sin variables nuevas.
