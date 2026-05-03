import { Injectable } from '@nestjs/common';
import { ResendMailService } from 'src/mail/resend-mail.service';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';

@Injectable()
export class SupportService {
  public constructor(private readonly resendMailService: ResendMailService) {}

  public async createSupportTicket(
    payload: CreateSupportTicketDto,
  ): Promise<void> {
    await this.resendMailService.sendSupportTicketEmail({
      fullName: payload.fullName,
      email: payload.email,
      subject: payload.subject,
      message: payload.message,
    });
  }
}
