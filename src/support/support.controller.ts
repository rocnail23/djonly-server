import { Body, Controller, Post } from '@nestjs/common';
import { Public } from 'src/auth/custom.decorator/public.decorator';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { SupportService } from './support.service';

@Public()
@Controller('support')
export class SupportController {
  public constructor(private readonly supportService: SupportService) {}

  @Post('tickets')
  public async createSupportTicket(
    @Body() payload: CreateSupportTicketDto,
  ): Promise<{ readonly message: string }> {
    await this.supportService.createSupportTicket(payload);
    return {
      message: 'Tu solicitud fue enviada. Te responderemos pronto.',
    };
  }
}
