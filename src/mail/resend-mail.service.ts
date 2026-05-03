import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Resend } from 'resend';
import { envs } from '../config/envs';

interface SendConfirmationEmailOptions {
  readonly to: string;
  readonly confirmationUrl: string;
}

interface SendRetrievePasswordEmailOptions {
  readonly to: string;
  readonly resetPasswordUrl: string;
  readonly purpose: 'RECOVERY' | 'CHANGE';
}

interface SendSupportTicketEmailOptions {
  readonly fullName: string;
  readonly email: string;
  readonly subject: string;
  readonly message: string;
}

@Injectable()
export class ResendMailService {
  private static readonly WELCOME_HERO_IMAGE_URL =
    'https://pub-a60ce02c629d4ca58249ffe3d51ae70e.r2.dev/heroWelcomeTemplate.jpg';
  private static readonly RESET_HERO_IMAGE_URL =
    'https://pub-a60ce02c629d4ca58249ffe3d51ae70e.r2.dev/HeroResetPasword.jpg';

  private readonly logger = new Logger(ResendMailService.name);
  private readonly resendClient: Resend | null;

  public constructor() {
    this.resendClient = envs.RESEND_API_KEY
      ? new Resend(envs.RESEND_API_KEY)
      : null;
  }

  public async sendConfirmationEmail(
    options: SendConfirmationEmailOptions,
  ): Promise<void> {
    const welcomeHeroImageUrl = ResendMailService.WELCOME_HERO_IMAGE_URL;
    await this.sendEmail({
      to: options.to,
      subject: 'Confirma tu cuenta en Only DJs',
      html: `
        <div style="margin:0;padding:0;background:#000000;font-family:Inter,Arial,sans-serif;color:#f1f5f9;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#000000;padding:24px 12px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;">
                  <tr>
                    <td align="center" style="padding:0 0 24px;">
                      <span style="display:inline-block;color:#ffd900;font-size:28px;line-height:1;vertical-align:middle;">●</span>
                      <span style="display:inline-block;margin-left:8px;font-size:22px;font-weight:900;letter-spacing:-0.02em;color:#f8fafc;vertical-align:middle;">ONLY DJs</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="background:#0f172acc;border:1px solid #1e293b;border-radius:16px;overflow:hidden;">
                      <img src="${welcomeHeroImageUrl}" alt="Visuales para DJs" width="620" style="display:block;width:100%;height:auto;border:0;" />
                      <div style="padding:36px 28px;text-align:center;">
                        <h1 style="margin:0 0 18px;font-size:34px;line-height:1.15;font-weight:900;letter-spacing:-0.02em;color:#f8fafc;">
                          ¡Bienvenido a <span style="color:#ffd900;">Only DJs</span>!
                        </h1>
                        <p style="margin:0 0 28px;font-size:17px;line-height:1.6;color:#94a3b8;">
                          Estás a un clic de acceder a nuestro catálogo de videos y assets visuales para DJs.
                          Confirma tu correo para empezar a explorar y comprar contenido exclusivo.
                        </p>
                        <a href="${options.confirmationUrl}" style="display:inline-block;background:#ffd900;color:#000000;text-decoration:none;font-weight:800;font-size:15px;letter-spacing:0.08em;padding:16px 28px;border-radius:10px;">
                          CONFIRMAR CUENTA
                        </a>
                        <div style="margin:24px auto 20px;width:64px;height:4px;background:rgba(255,217,0,0.25);border-radius:999px;"></div>
                        <p style="margin:0;font-size:13px;line-height:1.5;color:#64748b;">
                          Si no creaste esta cuenta, puedes ignorar este correo con seguridad.
                        </p>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:22px 12px 0;text-align:center;">
                      <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,217,0,0.7);font-weight:700;">
                        Only DJs - Video Assets para DJs
                      </p>
                      <p style="margin:0;font-size:11px;line-height:1.5;color:#475569;">
                        © 2026 Only DJs. Todos los derechos reservados.<br />
                        Si el botón no funciona, copia y pega este enlace en tu navegador:<br />
                        <a href="${options.confirmationUrl}" style="color:#94a3b8;text-decoration:underline;word-break:break-all;">${options.confirmationUrl}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </div>
      `,
    });
  }

  public async sendSupportTicketEmail(
    options: SendSupportTicketEmailOptions,
  ): Promise<void> {
    await this.sendEmail({
      to: envs.EMAIL_SUPPORT,
      subject: `Nuevo ticket de soporte: ${options.subject}`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;color:#0f172a;line-height:1.6;">
          <h2 style="margin-bottom:16px;">Nuevo ticket de soporte</h2>
          <p><strong>Nombre:</strong> ${options.fullName}</p>
          <p><strong>Correo:</strong> ${options.email}</p>
          <p><strong>Asunto:</strong> ${options.subject}</p>
          <p style="margin-top:16px;"><strong>Mensaje:</strong></p>
          <p style="white-space:pre-wrap;">${options.message}</p>
        </div>
      `,
    });
  }

  public async sendRetrievePasswordEmail(
    options: SendRetrievePasswordEmailOptions,
  ): Promise<void> {
    const resetHeroImageUrl = ResendMailService.RESET_HERO_IMAGE_URL;
    const isPasswordChange = options.purpose === 'CHANGE';
    const emailSubject = isPasswordChange
      ? 'Cambio de contraseña en Only DJs'
      : 'Recuperación de contraseña en Only DJs';
    const titleText = isPasswordChange
      ? 'Cambio de contraseña'
      : 'Recuperación de contraseña';
    const bodyText = isPasswordChange
      ? 'Recibimos una solicitud para cambiar tu contraseña de Only DJs desde tu cuenta autenticada. Si no fuiste tú, ignora este correo y revisa la seguridad de tu cuenta.'
      : 'Recibimos una solicitud para restablecer tu contraseña en Only DJs. Si no fuiste tú, puedes ignorar este correo. Si deseas continuar, usa el botón de abajo.';
    await this.sendEmail({
      to: options.to,
      subject: emailSubject,
      html: `
        <div style="margin:0;padding:0;background:#000000;font-family:Inter,Arial,sans-serif;color:#f1f5f9;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#000000;padding:24px 12px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#09090bcc;border:1px solid #27272a;border-radius:16px;overflow:hidden;">
                  <tr>
                    <td style="padding:40px 24px 24px;text-align:center;">
                      <span style="display:inline-block;background:#ffd900;padding:10px;border-radius:10px;line-height:1;">
                        <span style="font-size:28px;font-weight:900;color:#000000;">●</span>
                      </span>
                      <p style="margin:14px 0 0;font-size:26px;line-height:1.2;font-weight:900;letter-spacing:-0.02em;color:#f8fafc;">
                        ONLY <span style="color:#ffd900;">DJs</span>
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 24px 24px;">
                      <img src="${resetHeroImageUrl}" alt="${titleText}" width="572" style="display:block;width:100%;height:auto;border:1px solid #27272a;border-radius:12px;" />
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 24px 28px;text-align:center;">
                      <h2 style="margin:0 0 14px;font-size:30px;line-height:1.2;font-weight:900;letter-spacing:-0.02em;text-transform:uppercase;color:#f8fafc;">
                        ${titleText}
                      </h2>
                      <p style="margin:0 auto 24px;max-width:490px;font-size:16px;line-height:1.6;color:#a1a1aa;">
                        ${bodyText}
                      </p>
                      <a href="${options.resetPasswordUrl}" style="display:inline-block;background:#ffd900;color:#000000;text-decoration:none;font-weight:800;font-size:14px;letter-spacing:0.08em;padding:16px 28px;border-radius:10px;">
                        RESTABLECER CONTRASEÑA
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 24px 30px;">
                      <div style="padding-top:18px;border-top:1px solid #27272a;text-align:center;">
                        <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
                          Este enlace expirará en <strong style="color:#a1a1aa;">20 minutos</strong>
                          por seguridad.
                        </p>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="background:rgba(24,24,27,0.55);padding:20px 24px;border-top:1px solid #27272a;text-align:center;">
                      <p style="margin:0;font-size:11px;line-height:1.6;color:#52525b;text-transform:uppercase;letter-spacing:0.12em;">
                        © 2026 Only DJs. Todos los derechos reservados.
                      </p>
                      <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#71717a;">
                        Si el botón no funciona, copia y pega este enlace en tu navegador:<br />
                        <a href="${options.resetPasswordUrl}" style="color:#a1a1aa;text-decoration:underline;word-break:break-all;">${options.resetPasswordUrl}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </div>
      `,
    });
  }

  private async sendEmail(options: {
    readonly to: string;
    readonly subject: string;
    readonly html: string;
  }): Promise<void> {
    if (!this.resendClient) {
      this.logger.error('RESEND_API_KEY is not configured');
      throw new InternalServerErrorException('No se pudo enviar el correo');
    }
    if (!envs.RESEND_FROM_EMAIL) {
      this.logger.error('RESEND_FROM_EMAIL is not configured');
      throw new InternalServerErrorException('No se pudo enviar el correo');
    }

    try {
      const { error, data } = await this.resendClient.emails.send({
        from: envs.RESEND_FROM_EMAIL,
        to: [options.to],
        subject: options.subject,
        html: options.html,
      });
      this.logger.debug('Email sent with Resend', { data });
      if (error) {
        this.logger.error('Failed to send email with Resend', error);
        throw new InternalServerErrorException('No se pudo enviar el correo');
      }
    } catch (error: unknown) {
      this.logger.error('Unexpected error sending email with Resend', error);
      throw new InternalServerErrorException('No se pudo enviar el correo');
    }
  }
}
