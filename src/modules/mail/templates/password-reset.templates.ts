/**
 * Password-reset mail copy (ES). Plain functions so templates stay framework
 * free and unit-testable. Brand is neutral "TechAdvisor" (no copied assets).
 */
export function resetCodeMail(input: { code: string; ttlMin: number; supportEmail: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Restablece tu contraseña';
  const text =
    `Recibiste este correo porque alguien solicitó restablecer la contraseña ` +
    `de tu cuenta en TechAdvisor.\n\nTu código es: ${input.code}\n\n` +
    `Este código es válido por ${String(input.ttlMin)} minutos. Si no solicitaste este ` +
    `cambio, ignora este mensaje y tu contraseña permanecerá segura.`;
  const html =
    `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">` +
    `<h2>Restablece tu contraseña</h2>` +
    `<p>Recibiste este correo porque alguien solicitó restablecer la contraseña ` +
    `de la cuenta asociada a este email en <strong>TechAdvisor</strong>.</p>` +
    `<p>Utiliza el siguiente código para continuar:</p>` +
    `<p style="font-size:28px;letter-spacing:8px;text-align:center"><strong>${input.code}</strong></p>` +
    `<p>Este código es válido por <strong>${String(input.ttlMin)} minutos</strong>. Si no ` +
    `solicitaste este cambio, puedes ignorar este mensaje.</p>` +
    `<p>¿Dudas? Contacta a ${input.supportEmail}.</p></div>`;
  return { subject, html, text };
}

export function passwordChangedMail(input: { supportEmail: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Contraseña actualizada';
  const text =
    `Te confirmamos que tu contraseña en TechAdvisor ha sido cambiada ` +
    `exitosamente.\n\n¡Importante! Si no realizaste este cambio, contacta a ` +
    `${input.supportEmail} de inmediato para proteger tu cuenta.`;
  const html =
    `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">` +
    `<h2>Contraseña actualizada</h2>` +
    `<p>Te confirmamos que tu contraseña en <strong>TechAdvisor</strong> ha sido ` +
    `cambiada exitosamente.</p>` +
    `<p>¡Importante! Si no realizaste este cambio, contacta a ` +
    `<strong>${input.supportEmail}</strong> de inmediato para proteger tu cuenta.</p></div>`;
  return { subject, html, text };
}
