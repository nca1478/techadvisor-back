# Métodos de pago (ES) — PLANTILLA A REVISAR POR EL NEGOCIO

> **Aviso:** este documento es contenido de ejemplo claramente marcado como
> plantilla. No constituye una política comercial real: el negocio debe
> revisarlo, corregirlo y aprobarlo antes de publicarlo.

# Métodos de pago

## Métodos aceptados

- **Tarjeta de crédito y débito** (Visa, Mastercard, Amex) mediante Stripe.
- **Stripe Checkout**: el pago se completa en la página alojada de Stripe; la
  tienda nunca recibe ni almacena datos de tarjeta.

## Monedas

Los precios se muestran en las monedas soportadas configuradas en la tienda
(código ISO 4217 junto al importe). El cargo se realiza en la moneda del
pedido.

## Pagos fallidos

Si el pago falla o expira, la reserva de stock se libera automáticamente y el
pedido queda cancelado. Puedes intentarlo de nuevo creando otro pedido. Para
cargos duplicados aparentes, contacta con el equipo humano de soporte: solo
ellos pueden verificar el estado del cobro en Stripe.
