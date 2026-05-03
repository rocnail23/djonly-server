import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { type RequestWithUser } from 'src/auth/types/request-with-user.type';
import { Roles } from 'src/auth/custom.decorator/roles.decorator';
import { Role as UserRole } from 'src/generated/prisma/client';
import { FindAdminUsersQueryDto } from './dto/find-admin-users-query.dto';
import { FindStripeInvoicesQueryDto } from './dto/find-stripe-invoices-query.dto';
import { GrantManualSubscriptionDto } from './dto/grant-manual-subscription.dto';
import { UpdateAdminUserRoleDto } from './dto/update-admin-user-role.dto';
import {
  AdminDashboardResponse,
  AdminStripeInvoiceItem,
  PaginatedStripeInvoicesResponse,
  AdminUsersStatsResponse,
  PaginatedAdminUsersResponse,
  StripeBillingPortalResponse,
  UsersService,
} from './users.service';

@Controller('users')
export class UsersController {
  public constructor(private readonly usersService: UsersService) {}

  @Roles(UserRole.ADMIN)
  @Get('admin')
  public async listAdminUsers(
    @Query() query: FindAdminUsersQueryDto,
  ): Promise<PaginatedAdminUsersResponse> {
    return this.usersService.listAdminUsers(query);
  }

  @Roles(UserRole.ADMIN)
  @Get('admin/stats')
  public async getAdminUsersStats(): Promise<AdminUsersStatsResponse> {
    return this.usersService.getAdminUsersStats();
  }

  @Roles(UserRole.ADMIN)
  @Get('admin/dashboard')
  public async getAdminDashboard(): Promise<AdminDashboardResponse> {
    return this.usersService.getAdminDashboard();
  }

  @Roles(UserRole.ADMIN)
  @Patch('admin/:userId/role')
  public async updateAdminUserRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateAdminUserRoleDto,
  ): Promise<void> {
    await this.usersService.updateAdminUserRole({
      userId,
      role: body.role,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('admin/:userId/subscriptions/manual')
  public async grantManualSubscription(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: GrantManualSubscriptionDto,
  ): Promise<void> {
    await this.usersService.grantManualSubscription({
      userId,
      months: body.months,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('admin/:userId/subscriptions/cancel')
  public async cancelSubscriptionAsAdmin(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.usersService.cancelSubscriptionAsAdmin(userId);
  }

  @Roles(UserRole.ADMIN)
  @Get('admin/:userId/stripe/invoices')
  public async listStripeInvoicesForAdmin(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<readonly AdminStripeInvoiceItem[]> {
    return await this.usersService.listStripeInvoicesForAdmin(userId);
  }

  @Roles(UserRole.USER, UserRole.ADMIN)
  @Get('me/stripe/invoices')
  public async listStripeInvoicesForCurrentUser(
    @Query() query: FindStripeInvoicesQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<PaginatedStripeInvoicesResponse> {
    const userId = request.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Debes iniciar sesión para continuar');
    }
    return await this.usersService.listStripeInvoicesForCurrentUser({
      userId,
      page: query.page,
      limit: query.limit,
    });
  }

  @Roles(UserRole.USER, UserRole.ADMIN)
  @Post('me/stripe/billing-portal')
  public async createStripeBillingPortalForCurrentUser(
    @Req() request: RequestWithUser,
  ): Promise<StripeBillingPortalResponse> {
    const userId = request.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Debes iniciar sesión para continuar');
    }
    return await this.usersService.createStripeBillingPortalForUser(userId);
  }
}
