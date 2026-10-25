import { DynamicModule, MiddlewareConsumer, Module, NestModule, Provider, RequestMethod } from '@nestjs/common';
import { ROUTE_BALANCER_OPTIONS } from './options';
import { RouteBalancerService } from './balancer.service';
import { RouteBalancerMiddleware } from './proxy/middleware';
import type { RouteBalancerAsyncOptions, RouteBalancerOptions } from './types';

@Module({})
export class RouteBalancerModule implements NestModule {
  static forRoot(options: RouteBalancerOptions): DynamicModule {
    return { module: RouteBalancerModule, providers: [
      { provide: ROUTE_BALANCER_OPTIONS, useValue: options }, RouteBalancerService, RouteBalancerMiddleware,
    ], exports: [RouteBalancerService] };
  }
  static forRootAsync(options: RouteBalancerAsyncOptions): DynamicModule {
    const factory: Provider = { provide: ROUTE_BALANCER_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] };
    return { module: RouteBalancerModule, imports: options.imports ?? [], providers: [factory, RouteBalancerService, RouteBalancerMiddleware], exports: [RouteBalancerService] };
  }
  configure(consumer: MiddlewareConsumer): void {
    // Register globally, then match configured route prefixes inside middleware.
    // This also avoids coupling registration to a static forRootAsync configuration.
    consumer.apply(RouteBalancerMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
