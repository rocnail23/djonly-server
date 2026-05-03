import { Module } from '@nestjs/common';
import { MailModule } from 'src/mail/mail.module';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [MailModule],
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
